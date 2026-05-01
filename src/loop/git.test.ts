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

  test("autoCommit reports HEAD-advance as success when Claude committed itself", async () => {
    // Claude makes a change, commits it, and the working tree is now
    // clean. ccloop captures HEAD before the SDK runs and passes it
    // in — autoCommit must surface the advance as a real commit (not
    // a no-op) using Claude's own subject, otherwise no_progress
    // escalation falsely fires on a productive step.
    const { headSha } = await import("./git.ts");
    const prevHead = await headSha(dir);
    await writeFile(join(dir, "claude.txt"), "claude wrote this");
    await runGit(["add", "-A"], dir);
    await runGit(["commit", "-m", "feat: claude self-commit"], dir);
    const r = await autoCommit(dir, "fallback subject", prevHead);
    expect(r.committed).toBe(true);
    expect(r.subject).toBe("feat: claude self-commit");
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

  test("headDiffHash streams a multi-MB diff without buffering", async () => {
    // Regression: pre-streaming impl loaded the full git-diff stdout
    // into a string before hashing. A step that accidentally commits
    // a large dist/ would balloon memory just to compute a sha256.
    // 5 MB of distinct content makes the diff substantially larger
    // than that — the streaming path must complete and produce a
    // valid hex digest.
    const big = "x".repeat(5 * 1024 * 1024);
    await writeFile(join(dir, "big.txt"), big);
    await autoCommit(dir, "add big");
    const h = await headDiffHash(dir);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
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
