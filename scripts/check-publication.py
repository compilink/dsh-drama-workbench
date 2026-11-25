"""Check Git objects leaving this checkout without printing matched content."""

import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


VERSION = "8.30.1"
PRIVATE_DIRS = {
    ".git", ".ssh", ".aws", ".local", ".studio", ".drama", ".data", ".dsh", ".dsh-home",
    "sessions", "backups", "evidence", "drama-blobs", "video-artifacts",
}
PRIVATE_FILES = {
    ".credentials.yaml", ".credentials.yml", "credentials.yaml", "credentials.yml",
    "compose.override.yaml", "compose.override.yml", ".git-credentials", "id_rsa", "id_ed25519", ".netrc", ".ds_store",
}
PRIVATE_EXTENSION = re.compile(
    r"\.(?:pem|key|p12|pfx|kdbx|log|jsonl|sqlite3?(?:-.*)?|db(?:-.*)?)$", re.I
)
HOST_PATH = re.compile(
    rb"(?:/(?:Users/|home/(?!node/))[^/\s'\"<>]+/|/private/var/(?:folders)/|[a-z]:[\\/]+Users[\\/]+[^\\/\s]+[\\/])",
    re.I,
)


class Blocked(Exception):
    pass


def git(*args, data=None, cwd=None):
    return subprocess.run(
        ["git", *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=cwd, check=True,
    ).stdout


def local_list(name):
    path = Path(os.fsdecode(git("rev-parse", "--git-path", name).rstrip(b"\n")))
    if not path.exists():
        return []
    return [line for line in path.read_bytes().splitlines() if line.strip()]


def local_hashes(name):
    values = local_list(name)
    if any(not re.fullmatch(b"[0-9a-fA-F]{64}", value) for value in values):
        raise Blocked(f"Invalid SHA-256 in local Git file {name}.")
    return {value.decode("ascii").lower() for value in values}


def blocked_path(path):
    parts = path.lower().split("/")
    return (
        any(part in PRIVATE_DIRS or part.startswith((".studio-", ".drama-")) for part in parts)
        or parts[-1] in PRIVATE_FILES
        or (parts[-1].startswith(".env.") and parts[-1] != ".env.example")
        or parts[-1] == ".env"
        or PRIVATE_EXTENSION.search(parts[-1])
    )


class Guard:
    def __init__(self, tmp):
        self.tmp = tmp
        self.git_dir = os.fsdecode(git("rev-parse", "--absolute-git-dir").rstrip(b"\n"))
        self.markers = local_list("studio-private-markers")
        self.denied = local_hashes("studio-private-sha256")
        self.binary_ok = local_hashes("studio-reviewed-binaries")
        override = subprocess.run(
            ["git", "config", "--local", "--get", "studio.gitleaks"], capture_output=True,
        )
        executable = os.fsdecode(override.stdout.rstrip(b"\n")) if override.returncode == 0 else "gitleaks"
        self.gitleaks = shutil.which(executable)
        if not self.gitleaks:
            raise Blocked(f"Install Gitleaks {VERSION} or configure studio.gitleaks.")
        version = subprocess.run([self.gitleaks, "version"], capture_output=True, check=True)
        if version.stdout.decode().strip().removeprefix("v") != VERSION:
            raise Blocked(f"Use Gitleaks {VERSION}.")
        self.scans = tmp / "scan"
        self.scans.mkdir()
        self.config = tmp / "guard.toml"
        self.config.write_text("[extend]\nuseDefault = true\n")
        self.ignore = tmp / "empty-ignore"
        self.ignore.touch()
        self.seen = {}
        self.trees = set()
        self.named_scans = set()

    def private_text(self, label, data):
        if HOST_PATH.search(data) or any(marker in data for marker in self.markers):
            raise Blocked(f"Private text or host path in {label!r}.")

    def check_content(self, label, data):
        self.private_text(label, data)
        digest = hashlib.sha256(data).hexdigest()
        if digest in self.denied:
            raise Blocked(f"Known private file content in {label!r}.")
        if data.startswith(b"version https://git-lfs.github.com/spec/v1\n"):
            raise Blocked(f"Git LFS payload cannot be inspected in {label!r}.")
        try:
            if b"\0" in data:
                raise UnicodeError()
            data.decode("utf-8")
        except UnicodeError:
            if digest not in self.binary_ok:
                raise Blocked(f"Unreviewed binary in {label!r}. See docs/commit-checks.md.")
        # Also scan neutral filenames when a provider excludes the public extension.
        if digest not in self.seen:
            (self.scans / (digest + ".txt")).write_bytes(data)
            self.seen[digest] = label
        return digest

    def scan_blob(self, label, data):
        digest = self.check_content(label, data)
        if (label, digest) not in self.named_scans:
            # Preserve relative paths for detectors that only apply to a particular filename.
            dest = self.scans / digest / label
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.link(self.scans / (digest + ".txt"), dest)
            self.named_scans.add((label, digest))

    def check_tree(self, tree):
        if tree in self.trees:
            return
        self.trees.add(tree)
        entries = git("ls-tree", "-rz", "--full-tree", tree).split(b"\0")[:-1]
        paths = []
        with tempfile.TemporaryDirectory(dir=self.tmp) as checkout, subprocess.Popen(
            ["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        ) as reader:
            try:
                for entry in entries:
                    meta, path = entry.split(b"\t", 1)
                    mode, kind, oid = meta.split()
                    label = os.fsdecode(path)
                    if any(part in ("", ".", "..") for part in label.split("/")):
                        raise Blocked("Unsafe Git object path.")
                    self.private_text("Git filename", path)
                    if blocked_path(label):
                        raise Blocked(f"Local-only path {label!r}.")
                    if kind != b"blob":
                        raise Blocked(f"Cannot inspect Git object at {label!r}.")
                    reader.stdin.write(oid + b"\n")
                    reader.stdin.flush()
                    header = reader.stdout.readline().split()
                    if len(header) != 3 or header[:2] != [oid, b"blob"]:
                        raise Blocked("Could not read an indexed Git object.")
                    size = int(header[2])
                    data = reader.stdout.read(size)
                    if len(data) != size or reader.stdout.read(1) != b"\n":
                        raise Blocked("Incomplete Git object.")
                    if mode == b"120000":
                        target = posixpath.normpath(posixpath.join(posixpath.dirname(label), os.fsdecode(data)))
                        if (target in ("..", ".") or target.startswith(("../", "/")) or
                                b"\\" in data or blocked_path(target) or b":" in data):
                            raise Blocked(f"Local or external symlink at {label!r}.")
                        paths.append(os.fsencode(target))
                    self.scan_blob(label, data)
                    if label.split("/")[-1] == ".gitignore":
                        if mode == b"120000":
                            raise Blocked(f"Symlinked ignore file {label!r}.")
                        dest = Path(checkout) / label
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(data)
                    paths.append(path)
            finally:
                reader.stdin.close()
            if paths:
                self.check_content("Git filenames", b"\n".join(paths))
                # Evaluate the staged/historical ignore files, including nested rules.
                result = subprocess.run(
                    ["git", "--git-dir=" + self.git_dir, "--work-tree=" + checkout,
                     "check-ignore", "--no-index", "-z", "--stdin"],
                    input=b"\0".join(paths) + b"\0", cwd=checkout, capture_output=True,
                )
                if result.returncode == 0:
                    ignored = os.fsdecode(result.stdout.split(b"\0", 1)[0])
                    raise Blocked(f"Ignored path included in Git: {ignored!r}.")
                if result.returncode != 1:
                    raise Blocked("Could not evaluate Git ignore rules.")
        if reader.returncode:
            raise Blocked("Git object reader failed.")

    def check_push(self):
        commits = set()
        for line in sys.stdin.buffer:
            local_ref, local, remote_ref, remote = line.split()
            if not local.strip(b"0"):
                continue
            self.check_content("ref name", remote_ref)
            obj = local.decode("ascii")
            while git("cat-file", "-t", obj).strip() == b"tag":
                tag = git("cat-file", "tag", obj)
                self.check_content("tag " + obj[:10], tag)
                obj = tag.splitlines()[0].split()[1].decode("ascii")
            if git("cat-file", "-t", obj).strip() != b"commit":
                raise Blocked("Only commits and tags pointing to commits can be inspected.")
            args = ["rev-list", obj]
            if remote.strip(b"0"):
                previous = remote.decode("ascii") + "^{commit}"
                if subprocess.run(["git", "cat-file", "-e", previous], capture_output=True).returncode == 0:
                    args.append("^" + previous)
            commits.update(git(*args).decode("ascii").splitlines())
        for oid in sorted(commits):
            self.check_content("commit " + oid[:10], git("cat-file", "commit", oid))
            self.check_tree(git("rev-parse", oid + "^{tree}").decode().strip())

    def finish(self):
        if not self.seen:
            return
        report = self.tmp / "report.json"
        scan = subprocess.run([
            self.gitleaks, "dir", "--no-banner", "--redact=100",
            "--config", str(self.config), "--gitleaks-ignore-path", str(self.ignore),
            "--ignore-gitleaks-allow", "--max-decode-depth=3", "--max-archive-depth=3",
            "--report-format", "json", "--report-path", str(report), str(self.scans),
        ], cwd=self.tmp, capture_output=True)
        if scan.returncode != 0:
            if report.is_file():
                for item in json.loads(report.read_text()):
                    file = Path(item["File"])
                    name = next((p for p in file.parts if p in self.seen), file.stem)
                    print(f"Secret detection ({item['RuleID']}) in {self.seen.get(name, 'Git object')!r}.",
                          file=sys.stderr)
            raise Blocked("Gitleaks rejected the snapshot or could not complete the scan.")


def main():
    # Git replacement refs are local; pushes transfer the original objects.
    os.environ["GIT_NO_REPLACE_OBJECTS"] = "1"
    with tempfile.TemporaryDirectory(prefix="studio-git-check-") as tmp:
        guard = Guard(Path(tmp))
        command = sys.argv[1]
        if command == "staged":
            guard.check_tree(git("write-tree").decode().strip())
        elif command == "message":
            guard.check_content("commit message", Path(sys.argv[2]).read_bytes())
        elif command == "push":
            guard.check_push()
        else:
            raise Blocked("Expected staged, message, or push.")
        guard.finish()


if __name__ == "__main__":
    try:
        main()
    except (Blocked, OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError) as error:
        # Foreign command output can contain secrets. Keep diagnostics local and redacted.
        print(f"Publication check blocked: {error if isinstance(error, Blocked) else type(error).__name__}",
              file=sys.stderr)
        sys.exit(1)
