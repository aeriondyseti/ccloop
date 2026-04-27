import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoCommit,
  initRepoEmpty,
  isWorkingTreeClean,
  runGit,
  headSha,
  headDiffHash,
} from "./git.ts";

describe("git helpers (real git)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-git-"));
    // Configure committer locally so commits don't rely on global git config.
    await runGit(["init", "--quiet"], dir);
    await runGit(["config", "user.email", "test@example.com"], dir);
    await runGit(["config", "user.name", "ccloop test"], dir);
    await runGit(["commit", "--allow-empty", "-m", "init"], dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("isWorkingTreeClean true after init", async () => {
    expect(await isWorkingTreeClean(dir)).toBe(true);
  });

  test("autoCommit no-op on clean tree", async () => {
    const r = await autoCommit(dir, "msg");
    expect(r.committed).toBe(false);
  });

  test("autoCommit picks up new file", async () => {
    await writeFile(join(dir, "x.txt"), "hi");
    const r = await autoCommit(dir, "add x");
    expect(r.committed).toBe(true);
    expect(r.subject).toBe("add x");
    expect(r.sha).toMatch(/^[a-f0-9]{40}$/);
  });

  test("headDiffHash stable for same content", async () => {
    await writeFile(join(dir, "y.txt"), "first");
    await autoCommit(dir, "add y");
    const h1 = await headDiffHash(dir);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(join(dir, "z.txt"), "second");
    await autoCommit(dir, "add z");
    const h2 = await headDiffHash(dir);
    expect(h2).not.toBe(h1);
  });

  test("headSha returns 40-char sha", async () => {
    const s = await headSha(dir);
    expect(s).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe("initRepoEmpty", () => {
  test("creates repo with empty initial commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-git-init-"));
    try {
      // Pre-set git identity so the test doesn't depend on global config
      // (git init doesn't read user.* until commit time).
      await Bun.spawn({
        cmd: ["git", "init", "--quiet"], cwd: dir, stdout: "ignore", stderr: "ignore",
      }).exited;
      await runGit(["config", "user.email", "test@example.com"], dir);
      await runGit(["config", "user.name", "ccloop test"], dir);
      // Then call initRepoEmpty over the existing repo: "init" is idempotent.
      const sha = await initRepoEmpty(dir);
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
