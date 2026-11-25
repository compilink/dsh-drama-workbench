"""Run with GITLEAKS=/path/to/gitleaks python3 tests/test_publication_guard.py."""

import hashlib
import os
import random
import shutil
import string
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        top = Path(self.temp.name)
        self.work = top / "work"
        self.remote = top / "remote.git"
        self.work.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("init", "--bare", "-q", self.remote)
        self.git("config", "user.name", "Guard Test")
        self.git("config", "user.email", "maintainer@example.com")
        self.git("config", "core.hooksPath", PROJECT / ".githooks")
        self.git("config", "studio.gitleaks", os.environ.get("GITLEAKS", "gitleaks"))
        self.git("remote", "add", "origin", self.remote)
        (self.work / "scripts").mkdir()
        shutil.copy(PROJECT / "scripts/check-publication.py", self.work / "scripts")
        (self.work / ".gitignore").write_text(".env*\n!.env.example\nreview-only/\n")
        self.git("add", ".gitignore")
        self.git("commit", "-qm", "Start")
        self.git("push", "-q", "origin", "main")
        self.marker = "sample unpublishable " + "local note"
        (self.work / ".git/studio-private-markers").write_text(self.marker + "\n")

    def git(self, *args, ok=True):
        result = subprocess.run(["git", *args], cwd=self.work, capture_output=True)
        self.assertEqual(result.returncode == 0, ok, result.stderr.decode())
        return result.stderr.decode()

    def commit(self, ok=True):
        return self.git("commit", "-qm", "Edit", ok=ok)

    def test_partial_staging_uses_index_in_both_directions(self):
        f = self.work / "draft.md"
        f.write_text("safe")
        self.git("add", f)
        f.write_text(self.marker)
        self.commit()
        self.git("add", f)
        f.write_text("safe again")
        error = self.commit(ok=False)
        self.assertIn("draft.md", error)
        self.assertNotIn(self.marker, error)

    def test_gitleaks_and_message(self):
        generated = "".join(random.Random(941).sample(string.ascii_letters + string.digits, 36))
        candidate = "gh" + "p_" + generated
        f = self.work / "config.txt"
        f.write_text("access_token=" + candidate)
        self.git("add", f)
        message = self.commit(ok=False)
        self.assertIn("github-pat", message)
        self.assertNotIn(candidate, message)
        self.git("rm", "-qf", "--cached", f)
        self.git("commit", "-q", "--allow-empty", "-m", self.marker, ok=False)

    def test_ignore_rules_match_staged_tree_and_allow_example(self):
        (self.work / ".env.example").write_text("EXAMPLE=\n")
        self.git("add", ".env.example")
        self.commit()
        nested = self.work / "review-only"
        nested.mkdir()
        (nested / "note").write_text("data")
        self.git("add", "-f", "review-only/note")
        (self.work / ".gitignore").write_text("")
        self.assertIn("Ignored path", self.commit(ok=False))
        self.git("rm", "-q", "--cached", "review-only/note")
        ignored = self.work / ".gitignore"
        ignored.write_text("*.example\n")
        self.git("add", ignored)
        self.assertIn(".env.example", self.commit(ok=False))

    def test_private_overlay_paths_and_host_vs_container_home(self):
        cfg = self.work / "compose.override.yaml"
        cfg.write_text("test")
        self.git("add", cfg)
        self.assertIn("Local-only path", self.commit(ok=False))
        self.git("rm", "-qf", "--cached", cfg)
        local = self.work / ".local"
        local.mkdir()
        (local / "draft").write_text("test")
        self.git("add", "-f", ".local/draft")
        self.assertIn("Local-only path", self.commit(ok=False))
        self.git("rm", "-qf", "--cached", ".local/draft")
        f = self.work / "config.txt"
        f.write_text("/" + "home/node/workbench")
        self.git("add", f)
        self.commit()
        f.write_text("/" + "Users" + "/sample/workbench")
        self.git("add", f)
        self.assertIn("host path", self.commit(ok=False))

    def test_known_content_binary_and_symlinks(self):
        f = self.work / "renamed.txt"
        f.write_bytes(b"review draft")
        digest = hashlib.sha256(f.read_bytes()).hexdigest()
        (self.work / ".git/studio-private-sha256").write_text(digest + "\n")
        self.git("add", f)
        self.assertIn("Known private", self.commit(ok=False))
        f.write_bytes(b"\x00\xff\x10")
        self.git("add", f)
        self.assertIn("binary", self.commit(ok=False))
        (self.work / ".git/studio-reviewed-binaries").write_text(hashlib.sha256(f.read_bytes()).hexdigest())
        self.commit()
        (self.work / "bad-link").symlink_to("../local-secret")
        self.git("add", "bad-link")
        self.assertIn("symlink", self.commit(ok=False))

    def test_automatic_merge_checks_result_tree(self):
        self.git("switch", "-qc", "feature")
        (self.work / "feature.txt").write_text(self.marker)
        self.git("add", "feature.txt")
        self.git("commit", "--no-verify", "-qm", "Unchecked")
        self.git("switch", "-q", "main")
        (self.work / "main.txt").write_text("public")
        self.git("add", "main.txt")
        self.commit()
        error = self.git("merge", "--no-ff", "--no-edit", "feature", ok=False)
        self.assertIn("feature.txt", error)

    def test_intermediate_commit_stops_push_after_deletion(self):
        f = self.work / "entry"
        f.write_text(self.marker)
        self.git("add", f)
        self.git("commit", "--no-verify", "-qm", "Unchecked")
        self.git("rm", "-q", f)
        self.commit()
        self.assertIn("entry", self.git("push", "-q", "origin", "main", ok=False))
        self.git("config", "studio.gitleaks", "missing-guard-executable")
        self.assertIn("Install Gitleaks", self.git("push", "-q", "origin", "main", ok=False))


if __name__ == "__main__":
    unittest.main()
