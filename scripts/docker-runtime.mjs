// Assemble relocatable runtime dependencies from the pinned Linux DSH image.
import { cp, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { digest, projectPackage, projectRoot, readJson, resolveDependencies } from './dependencies.mjs';

const [dshRoot, output] = process.argv.slice(2);
if (!dshRoot || !output) throw new Error('Usage: docker-runtime.mjs DSH_ROOT OUTPUT_NODE_MODULES');
const {direct} = await resolveDependencies(dshRoot);
const project = await projectPackage();
const pinned = await readJson(join(projectRoot, 'compatibility.json'));
const owned = new Set();
for (const pkg of pinned.packages) {
  const dir = join(dshRoot, pkg.path);
  owned.add(dir);
  // The Linux build can have different TypeScript incremental metadata.
  for (const [file, hash] of [
    ['package.json', pkg.manifestSha256],
    ...pkg.artifactFiles.filter(f => !f.path.endsWith('.tsbuildinfo')).map(f => [join('lib', f.path), f.sha256])
  ]) {
    if (digest(await readFile(join(dir, file))) !== hash) throw new Error(`Pinned DSH artifact differs: ${pkg.name}/${file}`);
  }
}

async function linkPackage(target, link) {
  await mkdir(dirname(link), {recursive: true});
  await symlink(relative(dirname(link), target), link, 'dir');
}

async function resolveInstalled(name, parent, optional) {
  // Some packages hide package.json through their exports. Find its actual installation
  // through the same node_modules search directories that Node uses.
  const req = createRequire(join(parent, 'package.json'));
  for (const modules of req.resolve.paths(name)) {
    try { return await realpath(join(modules, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!optional) throw new Error(`Missing runtime dependency ${name} for ${parent}`);
}

const copies = new Map();
async function copyPackage(source) {
  if (copies.has(source)) return copies.get(source);
  const manifest = await readJson(join(source, 'package.json'));
  // The relative path retains distinct pnpm peer groups with the same version.
  const target = join(output, '.packages', relative(dshRoot, source));
  if (!resolve(target).startsWith(resolve(output, '.packages') + '/')) throw new Error(`Package outside the DSH build: ${source}`);
  copies.set(source, target);
  await mkdir(target, {recursive: true});
  if (owned.has(source)) {
    await cp(join(source, 'lib'), join(target, 'lib'), {recursive: true});
    await cp(join(source, 'package.json'), join(target, 'package.json'));
  } else {
    await cp(source, target, {recursive: true, verbatimSymlinks: true, filter: path => basename(path) !== 'node_modules'});
  }
  const dependencies = {...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies};
  for (const name of Object.keys(dependencies)) {
    const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional;
    const dep = await resolveInstalled(name, source, optional);
    if (dep) await linkPackage(await copyPackage(dep), join(target, 'node_modules', name));
  }
  return target;
}
for (const [name, {dir}] of direct) {
  await linkPackage(dir, join(projectRoot, 'node_modules', name));
  if (name in (project.dependencies ?? {}) || name in (project.peerDependencies ?? {})) {
    await linkPackage(await copyPackage(dir), join(output, name));
  }
}
console.log(`Verified ${owned.size} DSH packages and prepared ${copies.size} Linux runtime packages.`);
