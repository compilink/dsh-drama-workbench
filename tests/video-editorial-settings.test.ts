import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('local editorial text reaches stage instructions, contracts and review without changing tool permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-editorial-'));
  const file = join(root, 'settings.json');
  const modules = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const probe = `
    import { videoStageEditorialInstruction } from ${modules('video-editorial-standards')};
    import { renderVideoReviewPage } from ${modules('video-editorial-settings')};
    import { VIDEO_TOOL_CONTRACTS, stageContractPrompt } from ${modules('video-role-contracts')};
    console.log(JSON.stringify({
      script: videoStageEditorialInstruction('script'), audioInstruction: videoStageEditorialInstruction('audio'), role: stageContractPrompt('script'),
      audio: VIDEO_TOOL_CONTRACTS.local_audio, page: renderVideoReviewPage('<!-- video-review-checklist -->')
    }));
  `;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, STUDIO_VIDEO_EDITORIAL_FILE: file }, encoding: 'utf8',
  });
  try {
    writeFileSync(file, JSON.stringify({
      writingRules: ['A', 'B'], scriptFormat: 'Check:\n{rules}', scriptRole: 'Example role',
      audioExecutor: 'local test adapter', audioInstruction: 'Start with a sample', reviewItems: ['<example> & item'], numberedReview: true, reviewNote: 'OK',
    }));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const found = JSON.parse(result.stdout);
    assert.equal(found.script, 'Check:\nA\nB');
    assert.match(found.role, /Example role/);
    assert.equal(found.audioInstruction, 'Start with a sample');
    assert.equal(found.audio.executor, 'local test adapter');
    assert.equal(found.audio.state, 'adapter_pending');
    assert.equal(found.page, '<ol><li>&lt;example&gt; &amp; item</li></ol><p>OK</p>');
    for (const invalid of [{ state: 'available' }, { writingRules: 'bad' }, { scriptFormat: 'no rules' }]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.notEqual(run().status, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
