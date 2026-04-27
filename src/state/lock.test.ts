import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { LockHeldError, acquireLock } from "./lock.ts";

describe("acquireLock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("acquires when no lock present", async () => {
    const release = await acquireLock(join(dir, "ccloop.lock"));
    await release();
  });

  test("rejects when held by live PID", async () => {
    const path = join(dir, "ccloop.lock");
    await writeFile(path, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      started_at: new Date().toISOString(),
    }));
    await expect(acquireLock(path)).rejects.toBeInstanceOf(LockHeldError);
  });

  test("steals stale lock from dead PID on this host", async () => {
    const path = join(dir, "ccloop.lock");
    // PID 999999 almost certainly does not exist on a normal host.
    await writeFile(path, JSON.stringify({
      pid: 999999,
      hostname: hostname(),
      started_at: new Date(0).toISOString(),
    }));
    const release = await acquireLock(path);
    await release();
  });

  test("two acquires in a row work after release", async () => {
    const path = join(dir, "ccloop.lock");
    const r1 = await acquireLock(path);
    await r1();
    const r2 = await acquireLock(path);
    await r2();
  });
});
