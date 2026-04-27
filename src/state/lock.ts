import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";

export interface LockBody {
  pid: number;
  hostname: string;
  started_at: string;
}

export class LockHeldError extends Error {
  constructor(public readonly body: LockBody) {
    super(`ccloop is already running here (pid ${body.pid} on ${body.hostname}, since ${body.started_at}).`);
  }
}

/**
 * Try to acquire the lockfile. If a stale lock (PID dead on this host)
 * is found, replace it. Returns a release fn.
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const body = await readLockBody(path);
    if (body && isProcessAlive(body)) {
      throw new LockHeldError(body);
    }
    // Stale: remove and continue.
    await unlink(path).catch(() => {});
  }

  const me: LockBody = {
    pid: process.pid,
    hostname: hostname(),
    started_at: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    const body = await readLockBody(path);
    if (body) throw new LockHeldError(body);
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(me, null, 2), "utf8");
  } finally {
    await handle.close();
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(path).catch(() => {});
  };
}

async function readLockBody(path: string): Promise<LockBody | null> {
  try {
    const text = await readFile(path, "utf8");
    const obj = JSON.parse(text);
    if (
      typeof obj === "object" && obj !== null &&
      typeof obj.pid === "number" &&
      typeof obj.hostname === "string" &&
      typeof obj.started_at === "string"
    ) {
      return obj as LockBody;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(body: LockBody): boolean {
  if (body.hostname !== hostname()) {
    // Different host: we can't check; assume alive.
    return true;
  }
  try {
    process.kill(body.pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true; // exists but owned by another user
    return true;
  }
}
