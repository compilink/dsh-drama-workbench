import { randomUUID } from 'node:crypto';
import { mkdirSync, readlinkSync, statfsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const alreadyOwned = 'This studio data directory is already owned by a running process';

/** Acquires the native SQLite writer lock and claims the shared data directory across host/container filesystems. */
export function acquireRuntimeLock(dataDir: string): () => void {
  const lockDir = process.env.STUDIO_RUNTIME_LOCK_DIR ?? dataDir;
  mkdirSync(lockDir, {recursive: true, mode: 0o700});
  // Docker Desktop's fakeowner bind mounts do not share POSIX record locks between mount namespaces.
  if (process.platform === 'linux' && statfsSync(lockDir).type === 0x6a656a63) {
    throw new Error('Set STUDIO_RUNTIME_LOCK_DIR to a native Docker volume for a Docker Desktop bind-mounted data directory');
  }
  const db = new DatabaseSync(join(lockDir, 'runtime-lock.sqlite'));
  const marker = join(dataDir, '.runtime-owner');
  try {
    // Publish an immutable domain identity before holding the connection's process-lifetime write transaction.
    db.exec('CREATE TABLE IF NOT EXISTS domain(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO domain VALUES(1,?)').run(randomUUID());
    db.exec('BEGIN IMMEDIATE');
    const domain = String(db.prepare('SELECT token FROM domain WHERE id=1').get()!.token);
    try {
      symlinkSync(domain, marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Recover only a predecessor from this same native lock domain, whose writer lock has been released.
      if (readlinkSync(marker) !== domain) throw new Error(alreadyOwned + ' or reserved by a different runtime lock directory');
    }
  } catch (error) {
    db.close();
    if ((error as {errcode?: number}).errcode === 5) throw new Error(alreadyOwned, {cause: error});
    throw error;
  }
  return () => {
    try { unlinkSync(marker); }
    finally { db.close(); }
  };
}
