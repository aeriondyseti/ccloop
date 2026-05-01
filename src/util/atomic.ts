import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ensuredDirs = new Set<string>();

/** Write `body` to `path` atomically: write to a tmp sibling, then
 *  rename. A kill / crash mid-write leaves either the previous version
 *  or the new one — never a partial file. The tmp path is suffixed
 *  with the current PID so concurrent writers don't collide on a
 *  single tmp slot. Caller's `mkdir` is memoized per process so the
 *  parent-directory creation is paid once per dir. */
export async function atomicWriteFile(path: string, body: string): Promise<void> {
  const dir = dirname(path);
  if (!ensuredDirs.has(dir)) {
    await mkdir(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}
