import {readFile, stat} from 'node:fs/promises';
import {request} from 'node:http';
import {relative} from 'node:path';
import {text} from 'node:stream/consumers';

const MAX_BYTES = 2_097_152;

/** Reads a DSH model setting locally or through the Docker configuration reader. */
export async function readModelFile(path: string): Promise<string | undefined> {
  const socketPath = process.env.STUDIO_MODEL_SOURCE_SOCKET;
  if (socketPath) {
    const key = relative(process.env.STUDIO_DSH_HOME ?? '/model-source', path);
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({socketPath, path: '/' + key, method: 'GET', signal: AbortSignal.timeout(5000)}, resolve);
      req.on('error', reject);
      req.end();
    });
    if (response.statusCode === 404) { response.resume(); return undefined; }
    if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_BYTES) {
      response.resume();
      throw new Error('无法读取 DSH 模型配置，请检查配置读取服务和文件权限。');
    }
    return await text(response);
  }
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Configuration file must be a regular file under 2 MiB');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
