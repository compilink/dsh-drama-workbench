import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const projectPackage = () => readJson(join(projectRoot, 'package.json'));

export function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!((major === 22 && minor >= 19) || major >= 24)) {
    throw new Error(`Node ${process.versions.node} is unsupported. Use Node 22.19+ (22.x) or Node 24+; this project follows the DSH engine requirement.`);
  }
}

export async function packageIndex(dshRoot) {
  const index = new Map();
  async function scan(path, depth) {
    if (depth < 0) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const dir = join(path, entry.name);
      let manifest;
      try { manifest = await readJson(join(dir, 'package.json')); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (manifest?.name) index.set(manifest.name, { dir, manifest });
      else await scan(dir, depth - 1);
    }
  }
  await scan(join(dshRoot, 'packages'), 1);
  await scan(join(dshRoot, 'vendor'), 0);
  return index;
}

export async function resolveDependencies(dshRoot) {
  const pkg = await projectPackage();
  const index = await packageIndex(dshRoot);
  const requested = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
  const result = new Map();
  for (const [name, version] of Object.entries(requested)) {
    let resolved = index.get(name);
    if (!resolved) {
      for (const parent of [dshRoot, ...Array.from(index.values(), ({ dir }) => dir)]) {
        try {
          const req = createRequire(join(parent, 'package.json'));
          const manifestPath = req.resolve(`${name}/package.json`);
          resolved = { dir: dirname(await realpath(manifestPath)), manifest: await readJson(manifestPath) };
          break;
        } catch (error) {
          if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
        }
      }
    }
    if (!resolved) throw new Error(`Dependency ${name} is not available in the provided DSH build; no network install was attempted.`);
    if (resolved.manifest.version !== version) throw new Error(`${name}: expected ${version}, found ${resolved.manifest.version}`);
    result.set(name, resolved);
  }
  return { direct: result, index };
}

export function publicEntry(manifest) {
  const entry = manifest.exports?.['.'] ?? manifest.main;
  function pick(value) {
    if (typeof value === 'string') return value;
    if (!value) return undefined;
    return pick(value.import) ?? pick(value.node) ?? pick(value.default);
  }
  return pick(entry);
}

async function artifactFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await artifactFiles(dir, path));
    else if (entry.isFile() && !entry.name.endsWith('.tsbuildinfo')) files.push({ path, sha256: digest(await readFile(join(dir, path))) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function inspectCompatibility(dshRoot) {
  const { direct, index } = await resolveDependencies(dshRoot);
  const closure = new Map(direct);
  for (const { manifest } of closure.values()) {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (name.startsWith('@deepseek-ai/') && !closure.has(name) && index.has(name)) closure.set(name, index.get(name));
    }
  }
  const packages = [];
  for (const [name, { dir, manifest }] of [...closure].sort(([a], [b]) => a.localeCompare(b))) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    const entry = publicEntry(manifest);
    if (!entry || !entry.replace(/^\.\//, '').startsWith('lib/')) throw new Error(`${name} does not expose a built lib/ root entry.`);
    const entryBytes = await readFile(join(dir, entry));
    const files = await artifactFiles(join(dir, 'lib'));
    packages.push({
      name, version: manifest.version, path: relative(dshRoot, dir),
      direct: direct.has(name), entry, entrySha256: digest(entryBytes),
      manifestSha256: digest(await readFile(join(dir, 'package.json'))),
      artifactTreeSha256: digest(JSON.stringify(files)), artifactFiles: files,
    });
  }
  return {
    schemaVersion: 2,
    provenance: 'Fingerprints of the DSH package manifests and built public package files used by this release.',
    nodeEngine: '^22.19.0 || >=24.0.0',
    dsh: { version: (await readJson(join(dshRoot, 'package.json'))).version },
    packages,
    developmentDependencies: Object.fromEntries([...direct].filter(([name]) => !name.startsWith('@deepseek-ai/')).map(([name, { manifest }]) => [name, manifest.version])),
  };
}
