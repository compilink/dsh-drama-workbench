// A private Unix socket exposes only the model files accepted by this deployment.
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat, open, unlink} from 'node:fs/promises';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

const socket = '/run/drama-models/reader.sock';
const files = new Set(['/profiles/web/cordis.patch.yml', '/cordis.patch.yml', '/settings.yaml', '/.credentials.yaml', '/.env']);
const maxBytes = 2_097_152;
const lastRead = new Map();
process.umask(0o077);

async function readSnapshot(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat({bigint: true});
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid model source');
    const buffer = Buffer.allocUnsafe(64 * 1024), parts = [];
    let length = 0;
    for (;;) {
      const {bytesRead} = await handle.read(buffer);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) throw new Error('Model source exceeds size limit');
      parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const data = Buffer.concat(parts, length);
    const revision = [info.dev, info.ino, info.ctimeNs, info.mtimeNs].join(':');
    return {revision, size: info.size, data, hash: createHash('sha256').update(data).digest('hex')};
  } finally { await handle.close(); }
}

async function readStableFile(path) {
  let previous = await readSnapshot(path);
  for (const interval of [5, 15, 40, 100, 250, 600, 1000]) {
    // A Docker Desktop bind mount can briefly pair a replaced file's contents with the old inode's length.
    await delay(interval);
    const current = await readSnapshot(path);
    if (!previous && !current) { lastRead.delete(path); return undefined; }
    const accepted = lastRead.get(path);
    if (previous && current && previous.revision === current.revision && previous.size === current.size &&
        current.size === BigInt(current.data.length) && previous.hash === current.hash &&
        (accepted?.revision !== current.revision || accepted.hash === current.hash)) {
      lastRead.set(path, {revision: current.revision, hash: current.hash});
      return current.data;
    }
    previous = current;
  }
  throw new Error('Model source changed during read');
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'GET' || !files.has(req.url)) {
      res.writeHead(req.method === 'GET' && req.url === '/health' ? 204 : 403).end();
      return;
    }
    const data = await readStableFile('/source' + req.url);
    if (!data) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': data.byteLength}).end(data);
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 503);
    res.end();
  }
});

// A Compose service owns this socket volume. A forced stop can leave its socket inode behind.
try {
  const previous = await lstat(socket);
  if (!previous.isSocket()) throw new Error('Unexpected file at configuration reader socket');
  await unlink(socket);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
server.listen(socket);
