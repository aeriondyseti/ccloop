/**
 * Thin wrappers over the git CLI for ccloop's needs: dirty-tree
 * detection, auto-commit, init+empty-commit on greenfield. Uses
 * Bun.spawn so output is captured cleanly.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Sha, asSha } from "../branded.ts";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Cap individual git invocations so a stuck hook, lock file, or
 *  network filesystem can't stall the orchestrator overnight. Two
 *  minutes is generous enough for legitimate work (large repo
 *  rev-parse, complex pre-commit hooks) while bounding the worst
 *  case. Override via the second arg's `timeoutMs`. */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export async function runGit(
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number },
): Promise<GitResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (timedOut) {
      return {
        exitCode,
        stdout,
        stderr: stderr || `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`,
        timedOut: true,
      };
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return existsSync(join(cwd, ".git"));
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const r = await runGit(["status", "--porcelain"], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git status failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim().length === 0;
}

/** Init repo + empty initial commit per §0. */
export async function initRepoEmpty(cwd: string): Promise<Sha> {
  const init = await runGit(["init", "--quiet"], cwd);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
  const commit = await runGit(
    ["commit", "--allow-empty", "-m", "chore: ccloop init"],
    cwd,
  );
  if (commit.exitCode !== 0) {
    throw new Error(`initial commit failed: ${commit.stderr.trim()}`);
  }
  return await headSha(cwd);
}

export async function headSha(cwd: string): Promise<Sha> {
  const r = await runGit(["rev-parse", "HEAD"], cwd);
  if (r.exitCode !== 0) return asSha("");
  return asSha(r.stdout.trim());
}

export interface AutoCommitResult {
  committed: boolean;       // false = nothing to commit
  sha: Sha;
  subject: string;
}

/** Stage everything; commit with the given subject. No-ops if clean.
 *  If `prevHead` is provided and HEAD has advanced past it while the
 *  tree is clean (Claude committed its own work mid-step despite the
 *  prompt asking it not to), surface that as a real commit using
 *  Claude's subject — otherwise no_progress escalation falsely fires
 *  on a step that was actually productive. */
export async function autoCommit(
  cwd: string,
  subject: string,
  prevHead?: Sha,
): Promise<AutoCommitResult> {
  const add = await runGit(["add", "-A"], cwd);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim()}`);
  }
  if (await isWorkingTreeClean(cwd)) {
    const head = await headSha(cwd);
    if (prevHead && head && head !== prevHead) {
      const claudeSubject = await readHeadSubject(cwd);
      return { committed: true, sha: head, subject: claudeSubject || subject };
    }
    return { committed: false, sha: head, subject };
  }
  const commit = await runGit(["commit", "-m", subject], cwd);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
  return { committed: true, sha: await headSha(cwd), subject };
}

async function readHeadSubject(cwd: string): Promise<string> {
  const r = await runGit(["log", "-1", "--format=%s"], cwd);
  if (r.exitCode !== 0) return "";
  return r.stdout.trim();
}

/** Hash of HEAD vs HEAD~1 diff, whitespace-normalised, for §9.4.
 *  Streaming: for a step that accidentally commits a `node_modules`
 *  or `dist` directory the diff can be tens of MB; piping git's
 *  stdout straight into the hasher avoids buffering the whole thing
 *  in memory just to compute a sha256. */
export async function headDiffHash(cwd: string): Promise<string | null> {
  // Any spawn / stream-read / proc.exited failure → return null. The
  // diff hash is an input to the loop_detected heuristic (§9.4); a
  // missing entry just delays detection by a step. Without this
  // catch, a git crash mid-read would propagate up through
  // driver.stepOnce and the orchestrator would record it as a
  // spurious sdk_init failure, contributing toward a false escalation.
  try {
    const proc = Bun.spawn({
      cmd: ["git", "diff", "-w", "--no-color", "HEAD~1", "HEAD"],
      cwd,
      stdout: "pipe",
      // We don't read stderr — exit code is the signal — so let the
      // kernel discard it. Avoids the same in-memory buffering risk
      // we fixed for stdout: a `git diff` against a corrupt object
      // could in principle emit a lot of stderr.
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, DEFAULT_GIT_TIMEOUT_MS);
    try {
      const hasher = new Bun.CryptoHasher("sha256");
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
        }
      } finally {
        reader.releaseLock();
      }
      const exitCode = await proc.exited;
      if (timedOut || exitCode !== 0) return null;
      return hasher.digest("hex");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** §9.6 revert: hard reset to a known-good sha. */
export async function hardReset(cwd: string, sha: Sha): Promise<void> {
  const r = await runGit(["reset", "--hard", sha], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git reset --hard ${sha} failed: ${r.stderr.trim()}`);
  }
}

/** Current branch name in `cwd`. Returns null on detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  if (r.exitCode !== 0) return null;
  const name = r.stdout.trim();
  return name || null;
}

/** SHA pointed to by a local branch ref, or null if it doesn't exist. */
export async function branchSha(cwd: string, branch: string): Promise<Sha | null> {
  const r = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (r.exitCode !== 0) return null;
  const v = r.stdout.trim();
  return v ? asSha(v) : null;
}

/** Create a worktree at `wtPath` on a new branch `branch` based off `baseRef`. */
export async function addWorktree(
  repoDir: string,
  wtPath: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  const r = await runGit(["worktree", "add", "-b", branch, wtPath, baseRef], repoDir);
  if (r.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  }
}

/** Remove a linked worktree. `--force` so an unclean tree is acceptable;
 *  ccloop is the only writer in production runs. */
export async function removeWorktree(repoDir: string, wtPath: string): Promise<void> {
  const r = await runGit(["worktree", "remove", "--force", wtPath], repoDir);
  if (r.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
  }
}

/** Best-effort branch deletion. Used after a successful fast-forward
 *  has reattached the worktree's commits to the user's branch. */
export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  const r = await runGit(["branch", "-D", branch], repoDir);
  if (r.exitCode !== 0) {
    throw new Error(`git branch -D failed: ${r.stderr.trim()}`);
  }
}

export type FastForwardResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Attempt to fast-forward `branch` in `repoDir` to `newSha`. Succeeds
 *  only if `branch` still points at `expectedBaseSha` (i.e. nobody
 *  moved it during the run); otherwise returns a reason without
 *  mutating refs. If `branch` is the currently checked-out branch,
 *  uses `git merge --ff-only` so the working tree stays consistent;
 *  otherwise updates the ref directly. */
export async function tryFastForward(
  repoDir: string,
  branch: string,
  newSha: Sha,
  expectedBaseSha: Sha,
): Promise<FastForwardResult> {
  const cur = await branchSha(repoDir, branch);
  if (!cur) return { ok: false, reason: `branch \`${branch}\` not found` };
  if (cur !== expectedBaseSha) {
    return {
      ok: false,
      reason: `branch \`${branch}\` moved from ${expectedBaseSha.slice(0, 7)} to ${cur.slice(0, 7)} during the run`,
    };
  }
  const head = await currentBranch(repoDir);
  if (head === branch) {
    const r = await runGit(["merge", "--ff-only", String(newSha)], repoDir);
    if (r.exitCode !== 0) return { ok: false, reason: r.stderr.trim() || "merge --ff-only failed" };
    return { ok: true };
  }
  const r = await runGit(
    ["update-ref", `refs/heads/${branch}`, String(newSha), String(expectedBaseSha)],
    repoDir,
  );
  if (r.exitCode !== 0) return { ok: false, reason: r.stderr.trim() || "update-ref failed" };
  return { ok: true };
}
