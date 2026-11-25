import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNodeVersion, projectRoot } from './dependencies.mjs';

assertNodeVersion();
const command = process.argv[2];
const args = process.argv.slice(3);
function run(script, extra = [], env = process.env) {
  const result = spawnSync(process.execPath, [script, ...extra], { cwd: projectRoot, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function build(noEmit = false) {
  run(join(projectRoot, 'node_modules/typescript/bin/tsc'), ['-p', 'tsconfig.json', ...(noEmit ? ['--noEmit'] : [])]);
}
async function test() {
  const files = (await readdir(join(projectRoot, 'dist/tests'))).filter((name) => name.endsWith('.test.js')).sort().map((name) => join(projectRoot, 'dist/tests', name));
  if (!files.length) throw new Error('No compiled node:test files were found.');
  run('--test', ['--test-concurrency=1', ...files, ...args]);
}
switch (command) {
  case 'build': build(); break;
  case 'typecheck': build(true); break;
  case 'test': build(); await test(); break;
  case 'bundle': build(); run('--test', [join(projectRoot, 'dist/tests/bundle.test.js')]); break;
  case 'check': run(join(projectRoot, 'scripts/compatibility.mjs')); build(); await test(); break;
  case 'workbench': build(); run(join(projectRoot, 'dist/src/server.js'), ['--drama', ...args]); break;
  case 'workbench-demo': build(); run(join(projectRoot, 'dist/src/server.js'), ['--drama', ...args], { ...process.env, STUDIO_DEMO: '1' }); break;
  case 'start': run(join(projectRoot, 'dist/src/server.js'), args); break;
  case 'demo': build(); run(join(projectRoot, 'dist/src/server.js'), args, { ...process.env, STUDIO_DEMO: '1' }); break;
  default: throw new Error(`Unknown command ${command}`);
}
