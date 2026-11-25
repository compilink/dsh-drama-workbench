import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertNodeVersion, inspectCompatibility, projectRoot } from './dependencies.mjs';

assertNodeVersion();
const pinned = JSON.parse(await readFile(join(projectRoot, 'compatibility.json'), 'utf8'));
const agentPath = await realpath(join(projectRoot, 'node_modules/@deepseek-ai/dsh-agent'));
const dshRoot = process.env.DSH_ROOT ?? dirname(dirname(dirname(agentPath)));
const actual = await inspectCompatibility(dshRoot);
if (JSON.stringify(actual) !== JSON.stringify(pinned)) throw new Error('The linked DSH artifacts do not match compatibility.json.');
async function verifyPublicImports(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await verifyPublicImports(path);
    else if (entry.name.endsWith('.ts')) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](@deepseek-ai\/[^"']+)["']/g)) {
        if (/\/(src|lib|tests)\//.test(match[1]) || /testkit|test-support/.test(match[1])) throw new Error(`Private or source-plane DSH import in ${path}: ${match[1]}`);
      }
    }
  }
}
await verifyPublicImports(join(projectRoot, 'src'));
const required = {
  '@deepseek-ai/cordis': ['Context'],
  '@deepseek-ai/dsh-agent': ['default', 'installModelSelection'],
  '@deepseek-ai/dsh-agent-loop': ['default'],
  '@deepseek-ai/dsh-llm': ['default'],
  '@deepseek-ai/dsh-session': ['default'],
  '@deepseek-ai/dsh-tools': ['default'],
  '@deepseek-ai/dsh-system-prompt': ['default'],
  '@deepseek-ai/dsh-subagent': ['default'],
  '@deepseek-ai/dsh-subagent-spawn-in-process': ['apply'],
  '@deepseek-ai/dsh-session-persistence-jsonl': ['default'],
  '@deepseek-ai/dsh-llm-pi-ai': ['apply'],
  '@deepseek-ai/dsh-llm-deepseek': ['apply'],
  '@deepseek-ai/dsh-settings-file': ['default'],
  '@deepseek-ai/dsh-credentials': ['default'],
  '@deepseek-ai/dsh-compaction': ['CompactionEngine'],
  '@deepseek-ai/dsh-compaction-basic': ['BasicCompactionEngine'],
  '@deepseek-ai/dsh-token-meter': ['default'],
};
for (const [specifier, exports] of Object.entries(required)) {
  const module = await import(specifier);
  for (const name of exports) if (!(name in module)) throw new Error(`${specifier} lacks required public export ${name}`);
}
console.log(`Compatibility verified: ${actual.packages.length} DSH artifact trees and ${Object.keys(required).length} public module imports. Local built artifacts only; npm registry availability is unverified.`);
