/**
 * Run a user-defined shell command after each successful step to
 * verify the change before committing. Non-zero exit → step is
 * recorded as a `gate` failure and not committed; the captured
 * output feeds the next prompt's `last_error` block.
 *
 * The command is invoked via the user's shell so multi-step
 * pipelines work without ccloop owning a parser (`bun run typecheck
 * && bun test` is the common case). Bounded by a configurable
 * timeout so a hung gate can't stall the orchestrator overnight.
 */

import { capExcerpt } from "./classify.ts";

export interface GateResult {
  ok: boolean;
  exitCode: number;
  /** Combined stdout+stderr, capped at the excerpt width so it can be
   *  fed into the prompt directly. */
  excerpt: string;
  timedOut: boolean;
}

export interface GateOptions {
  cwd: string;
  command: string;
  timeoutSeconds: number;
}

const TAIL_LINES = 80;

export async function runGate(opts: GateOptions): Promise<GateResult> {
  const timeoutMs = opts.timeoutSeconds * 1000;
  // Run the command in a fresh process group via setsid so we can kill
  // the whole subtree on timeout. A typecheck/test runner that shells
  // out (`bun run typecheck && bun test`) leaves grandchildren alive
  // if we only signal sh; killing the group reaps them.
  const proc = Bun.spawn({
    cmd: ["setsid", "sh", "-c", opts.command],
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      // setsid makes the child a process-group leader with pgid=pid.
      // Negative pid → kill(2) targets the whole group.
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Process already exited; nothing to kill.
    }
  }, timeoutMs);
  try {
    // Drain streams concurrently with the exit wait. Awaiting either
    // alone deadlocks: streams stay open until the process closes its
    // pipes, and Bun's `.exited` can sit pending while a child has
    // buffered output. SIGKILL's EOF on the pipes lets both resolve.
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const combined = (stdout + (stderr ? `\n${stderr}` : "")).trim();
    const tail = lastLines(combined, TAIL_LINES);
    if (timedOut) {
      const msg = `gate command timed out after ${opts.timeoutSeconds}s\n${tail}`;
      return { ok: false, exitCode, excerpt: capExcerpt(msg), timedOut: true };
    }
    if (exitCode === 0) {
      return { ok: true, exitCode, excerpt: "", timedOut: false };
    }
    const head = `gate command failed (exit ${exitCode}): ${truncateInline(opts.command, 120)}\n${tail}`;
    return { ok: false, exitCode, excerpt: capExcerpt(head), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

function lastLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

function truncateInline(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
