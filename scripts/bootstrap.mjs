import { mkdir, lstat, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertNodeVersion, inspectCompatibility, projectRoot, resolveDependencies } from './dependencies.mjs';

assertNodeVersion();
const dshRoot = await realpath(resolve(process.env.DSH_ROOT ?? process.argv.find((arg) => arg.startsWith('--dsh-root='))?.slice(11) ?? '../deepseek-harness'));
if (dshRoot === projectRoot || projectRoot.startsWith(`${dshRoot}/`)) throw new Error('The Studio project must be outside the DSH repository.');
const record = process.argv.includes('--record');
const actual = await inspectCompatibility(dshRoot);
const compatibilityPath = join(projectRoot, 'compatibility.json');
if (record) {
  await writeFile(compatibilityPath, `${JSON.stringify(actual, null, 2)}\n`);
} else {
  const pinned = JSON.parse(await readFile(compatibilityPath, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(pinned)) throw new Error('The provided DSH build differs from compatibility.json. Review the package versions and built file hashes before explicitly refreshing with --record.');
}
const { direct } = await resolveDependencies(dshRoot);
for (const [name, { dir }] of direct) {
  const dest = join(projectRoot, 'node_modules', name);
  await mkdir(resolve(dest, '..'), { recursive: true });
  let existing;
  try { existing = await lstat(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isSymbolicLink() || await realpath(dest) !== await realpath(dir)) throw new Error(`Refusing to replace existing dependency ${dest}`);
  } else await symlink(dir, dest, 'dir');
}
console.log(`Linked ${direct.size} version-pinned dependencies from ${dshRoot}. DSH files were only read; source and private testkit imports are not used.`);
