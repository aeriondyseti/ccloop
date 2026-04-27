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
}

export async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
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

/** Stage everything; commit with the given subject. No-ops if clean. */
export async function autoCommit(
  cwd: string,
  subject: string,
): Promise<AutoCommitResult> {
  const add = await runGit(["add", "-A"], cwd);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim()}`);
  }
  if (await isWorkingTreeClean(cwd)) {
    return { committed: false, sha: await headSha(cwd), subject };
  }
  const commit = await runGit(["commit", "-m", subject], cwd);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
  return { committed: true, sha: await headSha(cwd), subject };
}

/** Hash of HEAD vs HEAD~1 diff, whitespace-normalised, for §9.4. */
export async function headDiffHash(cwd: string): Promise<string | null> {
  const r = await runGit(
    ["diff", "-w", "--no-color", "HEAD~1", "HEAD"],
    cwd,
  );
  if (r.exitCode !== 0) return null;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(r.stdout);
  return hasher.digest("hex");
}

/** §9.6 revert: hard reset to a known-good sha. */
export async function hardReset(cwd: string, sha: Sha): Promise<void> {
  const r = await runGit(["reset", "--hard", sha], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git reset --hard ${sha} failed: ${r.stderr.trim()}`);
  }
}
