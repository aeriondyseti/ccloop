import { existsSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import React from "react";
import { parseRunFlags } from "../config/flags.ts";
import { loadConfig } from "../config/load.ts";
import { validateSpec } from "../config/spec.ts";
import { decideMatrix } from "./matrix.ts";
import { confirmDefaultYes } from "./prompt.ts";
import { runInit } from "./init.ts";
import { CCLOOP_DIR, CONFIG_FILENAME, SPEC_FILENAME, runtimePaths } from "../state/paths.ts";
import {
  autoCommit, initRepoEmpty, isGitRepo, isWorkingTreeClean,
} from "../loop/git.ts";
import { acquireLock, LockHeldError } from "../state/lock.ts";
import { LoopDriver } from "../loop/driver.ts";
import { runLoop } from "../loop/orchestrator.ts";
import { EventBus } from "../loop/eventBus.ts";
import { UsageClient } from "../usage/client.ts";
import { loadOAuthToken } from "../auth/loadToken.ts";
import { Dashboard, type MenuKey } from "../tui/Dashboard.tsx";
import { project } from "../tui/projector.ts";
import { EMPTY_VIEW } from "../tui/types.ts";
import type { TuiViewModel } from "../tui/types.ts";
import type { CcloopState } from "../state/state.ts";
import { findLastGreenSha, loadRecentSteps } from "../state/stepLoader.ts";
import { decideEscalationKey, resetForContinue } from "../loop/escalation.ts";
import { hardReset } from "../loop/git.ts";
import { writeState } from "../state/state.ts";
import { spawnSync } from "node:child_process";

const TUI_TICK_MS = 250;
const HEARTBEAT_INTERVAL_MS = 1000;
const LOG_CAP = 500;
const RECENT_STEPS_CAP = 200;
/** Window during which a second Ctrl+C is treated as "force exit". */
const FORCE_EXIT_WINDOW_MS = 3000;

export async function runRun(argv: string[]): Promise<number> {
  let flags;
  try {
    flags = parseRunFlags(argv);
  } catch (err) {
    process.stderr.write(`ccloop run: ${(err as Error).message}\n`);
    return 1;
  }

  const cwd = process.cwd();

  // 1. SPEC.md + .ccloop/ matrix per §12.4.
  const hasCcloopDir = existsSync(join(cwd, CCLOOP_DIR));
  const hasSpec = existsSync(join(cwd, SPEC_FILENAME));
  const decision = decideMatrix({ hasCcloopDir, hasSpec, cont: flags.cont });

  if (decision.kind === "refuse") {
    process.stderr.write(`ccloop: ${decision.reason}\n`);
    return 1;
  }
  if (decision.kind === "scaffold_or_exit") {
    const yes = await confirmDefaultYes(`No ${SPEC_FILENAME} found. Scaffold?`, flags.yes);
    if (!yes) return 0;
    const code = await runInit([]);
    if (code !== 0) return code;
    process.stdout.write(`Edit ${SPEC_FILENAME}, then run \`ccloop run\`.\n`);
    return 0;
  }
  if (decision.kind === "resume_after_confirm") {
    const yes = await confirmDefaultYes(
      "Existing run found. Continue?",
      flags.yes,
    );
    if (!yes) return 0;
  }

  // 2. Load config + validate spec.
  let config;
  try {
    config = await loadConfig(cwd, flags);
  } catch (err) {
    process.stderr.write(`ccloop: ${(err as Error).message}\n`);
    return 1;
  }
  const specCheck = await validateSpec(cwd);
  if (!specCheck.ok) {
    process.stderr.write(`ccloop: ${specCheck.error}\n`);
    return 1;
  }

  // 3. Auth gate.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const discovered = loadOAuthToken();
  const token = discovered?.token ?? "";
  if (!token && !apiKey) {
    process.stderr.write(
      "ccloop: missing auth. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token` for a long-lived headless token), log in via `claude /login`, or set ANTHROPIC_API_KEY.\n",
    );
    return 2;
  }
  if (token && discovered && discovered.source !== "env") {
    // Make the discovered token visible to the SDK regardless of whether
    // it does its own discovery, and tell the user where it came from.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    const where =
      discovered.source === "keychain-macos"
        ? `macOS keychain (${discovered.detail})`
        : `${discovered.detail}`;
    process.stderr.write(`ccloop: using OAuth token from ${where}\n`);
  }

  // 4. Git repo + dirty-tree gate per §0 / §10.4.
  if (!(await isGitRepo(cwd))) {
    if (await isCwdGreenfield(cwd)) {
      process.stdout.write("ccloop: empty CWD, running git init…\n");
      try {
        await initRepoEmpty(cwd);
      } catch (err) {
        process.stderr.write(`ccloop: ${(err as Error).message}\n`);
        return 1;
      }
    } else {
      process.stderr.write(
        "ccloop: CWD has files but no .git/. Initialize git manually before running ccloop.\n",
      );
      return 1;
    }
  } else if (decision.kind !== "resume_after_confirm" && decision.kind !== "resume_no_prompt") {
    if (!(await isWorkingTreeClean(cwd))) {
      process.stderr.write(
        "ccloop: working tree is dirty. Commit or stash before starting a fresh run (`git status`).\n",
      );
      return 1;
    }
  }
  // §10.4 recovery commit: --continue with a dirty tree means the
  // previous instance was killed mid-step. Auto-commit whatever's
  // there before resuming so the loop has a clean baseline. Step
  // number is filled in once state is loaded (see below).
  const isResume = decision.kind === "resume_after_confirm" || decision.kind === "resume_no_prompt";
  const needsRecoveryCommit = isResume && !(await isWorkingTreeClean(cwd));

  // 5. Set caching env opt-in per §6.6.
  process.env.ENABLE_PROMPT_CACHING_1H = process.env.ENABLE_PROMPT_CACHING_1H ?? "1";

  // 6. Lock.
  const paths = runtimePaths(cwd);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(paths.lock);
  } catch (err) {
    if (err instanceof LockHeldError) {
      process.stderr.write(`ccloop: ${err.message}\n`);
      return 3;
    }
    process.stderr.write(`ccloop: ${(err as Error).message}\n`);
    return 1;
  }

  // 7. Build driver, bus, optional usage client.
  const bus = new EventBus<import("../loop/driver.ts").DriverEvent>();
  const driver = new LoopDriver(cwd, paths, config, bus);
  const state = await driver.loadOrInitState();

  if (needsRecoveryCommit) {
    try {
      const r = await autoCommit(
        cwd,
        `chore(ccloop): recovery commit before resume of step ${state.current_step}`,
      );
      if (r.committed) {
        process.stderr.write(
          `ccloop: recovered dirty tree into commit ${r.sha.slice(0, 7)}.\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`ccloop: recovery commit failed: ${(err as Error).message}\n`);
      if (release) await release();
      return 1;
    }
  }

  const usageClient = token
    ? new UsageClient({ token })
    : null;

  // 8. SIGINT/SIGTERM handler — propagate via AbortController.
  const aborter = new AbortController();
  let exitSignalCode = 0;
  const onSig = (code: number) => () => {
    exitSignalCode = code;
    aborter.abort();
  };
  const onSigInt = onSig(130);
  const onSigTerm = onSig(143);
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  // 9. TUI: render via ink. Renders are dirty-driven — the tick wakes
  // up at TUI_TICK_MS but only repaints if a buffer changed or the
  // heartbeat needs to flip. At 4Hz with full-frame terminal redraws,
  // unconditional rerendering visibly flickers on borderbox layouts.
  let view: TuiViewModel = { ...EMPTY_VIEW, cwd, runId: state.run_id, step: state.current_step };
  let logBuffer: string[] = [];
  let nowBuffer: import("../tui/types.ts").TurnEvent[] = [];
  let heartbeat: "●" | "○" = "●";
  let lastHeartbeatToggleMs = Date.now();
  let viewDirty = true;
  let finalCommitSha = "";
  let stepsDirty = true;
  let cachedRecent: import("../loop/stepRecord.ts").StepRecord[] = [];
  let interrupting = false;
  let firstInterruptAt = 0;
  let cadenceWait: { startedAt: string; totalMs: number } | null = null;
  bus.subscribe((e) => {
    if (e.type === "stream_chunk") {
      nowBuffer = [...nowBuffer, e.turn];
      viewDirty = true;
      return;
    }
    if (e.type === "cadence_wait_enter") {
      cadenceWait = { startedAt: e.started_at, totalMs: e.total_ms };
      viewDirty = true;
      return;
    }
    if (e.type === "cadence_wait_exit") {
      cadenceWait = null;
      viewDirty = true;
      return;
    }
    if (e.type === "step_start") {
      // New step begins — clear the now pane so it shows only the
      // current step's stream.
      nowBuffer = [];
      viewDirty = true;
    }
    const line = eventToLine(e);
    if (line) {
      logBuffer = [...logBuffer, line].slice(-LOG_CAP);
      viewDirty = true;
    }
    if (e.type === "step_end") {
      stepsDirty = true;
      viewDirty = true;
    }
    if (e.type === "done" && "final_commit_sha" in e) {
      finalCommitSha = String(e.final_commit_sha);
      viewDirty = true;
    }
  });
  // Closure-shared menu key handler. Set during ESCALATED /
  // GUARDRAIL_TRIP single-key prompts; tick timer threads it through
  // every rerender so Ink's useInput in those screens has somewhere
  // to dispatch keystrokes.
  let menuKeyHandler: ((key: MenuKey) => void) | null = null;
  const onInterrupt = (): void => {
    const now = Date.now();
    if (interrupting && now - firstInterruptAt < FORCE_EXIT_WINDOW_MS) {
      // Second press within the grace window — give up on graceful
      // shutdown. Restore terminal and bail.
      ink.unmount();
      process.exit(130);
    }
    interrupting = true;
    firstInterruptAt = now;
    aborter.abort();
    viewDirty = true;
  };
  const ink = render(React.createElement(Dashboard, { view, onInterrupt }), {
    exitOnCtrlC: false,
  });
  if (usageClient) void usageClient.get();
  const usagePollTimer = usageClient ? setInterval(() => {
    void usageClient.get();
    viewDirty = true;
  }, 30_000) : null;
  const tickTimer = setInterval(async () => {
    if (stepsDirty) {
      cachedRecent = await loadRecentSteps(paths.steps, RECENT_STEPS_CAP);
      stepsDirty = false;
      viewDirty = true;
    }
    const now = Date.now();
    let beat = false;
    if (now - lastHeartbeatToggleMs >= HEARTBEAT_INTERVAL_MS) {
      heartbeat = heartbeat === "●" ? "○" : "●";
      lastHeartbeatToggleMs = now;
      beat = true;
    }
    if (!viewDirty && !beat) return;
    viewDirty = false;
    view = buildView(
      state, cwd, usageClient, logBuffer, nowBuffer, heartbeat,
      cachedRecent, finalCommitSha,
      undefined, interrupting, cadenceWait,
    );
    ink.rerender(React.createElement(Dashboard, {
      view, onMenuKey: menuKeyHandler ?? undefined, onInterrupt,
    }));
  }, TUI_TICK_MS);

  const readMenuKey = (
    allowed: ReadonlyArray<MenuKey>,
    abortSignal: AbortSignal,
  ): Promise<MenuKey> => {
    return new Promise<MenuKey>((resolve) => {
      let settled = false;
      const finish = (k: MenuKey) => {
        if (settled) return;
        settled = true;
        menuKeyHandler = null;
        abortSignal.removeEventListener("abort", onAbort);
        resolve(k);
      };
      const onAbort = () => finish("q");
      menuKeyHandler = (k) => {
        if (allowed.includes(k)) finish(k);
      };
      // Force an immediate rerender so the new handler attaches
      // without waiting for the next tick.
      ink.rerender(React.createElement(Dashboard, {
        view, onMenuKey: menuKeyHandler, onInterrupt,
      }));
      if (abortSignal.aborted) return finish("q");
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  // 10. Drive the loop, handling escalation cycles.
  let exitCode = 0;
  try {
    let resolved = false;
    while (!resolved) {
      const outcome = await runLoop(state, {
        config, paths, driver, bus, abortSignal: aborter.signal,
        usage: usageClient,
        notifyOptions: { pushUrl: config.notify.push_url, webhookUrl: config.notify.webhook_url },
      });
      if (outcome.kind === "done") { exitCode = 0; resolved = true; }
      else if (outcome.kind === "guardrail_trip") {
        await handleGuardrailTrip(cwd, aborter.signal, readMenuKey);
        exitCode = 4;
        resolved = true;
      }
      else if (outcome.kind === "cancelled") {
        exitCode = exitSignalCode || 130;
        resolved = true;
      }
      else if (outcome.kind === "escalated") {
        const action = await handleEscalation(state, paths, cwd, aborter.signal, readMenuKey);
        if (action === "quit") { exitCode = 5; resolved = true; }
        // continue / revert / edit_spec → loop again with reset state
      }
    }
  } catch (err) {
    process.stderr.write(`\nccloop: fatal error: ${(err as Error).message}\n`);
    exitCode = 1;
  } finally {
    clearInterval(tickTimer);
    if (usagePollTimer) clearInterval(usagePollTimer);
    cachedRecent = await loadRecentSteps(paths.steps, RECENT_STEPS_CAP);
    view = buildView(
      state, cwd, usageClient, logBuffer, nowBuffer, heartbeat,
      cachedRecent, finalCommitSha,
      undefined, interrupting, cadenceWait,
    );
    ink.rerender(React.createElement(Dashboard, { view }));
    ink.unmount();
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (release) await release();
  }
  return exitCode;
}

async function isCwdGreenfield(cwd: string): Promise<boolean> {
  // Empty, or only SPEC.md / ccloop.toml / .ccloop/ present.
  const allowed = new Set([SPEC_FILENAME, CONFIG_FILENAME, CCLOOP_DIR]);
  const entries = await Array.fromAsync(
    new Bun.Glob("*").scan({ cwd, dot: false, onlyFiles: false }),
  );
  for (const name of entries) {
    if (!allowed.has(name)) return false;
  }
  return true;
}

/** Format a bus event into a one-line log entry for the log pane.
 *  Returning empty string suppresses the entry entirely. */
function eventToLine(e: { ts: string; type: string } & Record<string, unknown>): string {
  const t = e.ts.replace("T", " ").replace(/T?\.\d+Z$/, "Z").slice(11, 19);
  switch (e.type) {
    case "step_start":
      return `${t}  step ${e.step} started`;
    case "step_end": {
      const subtype = String(e.subtype ?? "");
      const dur = formatDurationShort(numberOr(e.duration_ms, 0));
      const cost = `$${numberOr(e.cost_usd, 0).toFixed(2)}`;
      const sha = String(e.commit_sha ?? "").slice(0, 7);
      const out = String(e.outcome ?? subtype);
      // Use the text-style check / cross (✓ / ✗) rather than ✔ / ✘:
      // the latter are sometimes auto-promoted to emoji presentation
      // by the terminal (rendering as 2 columns) while string-width
      // counts them as 1 — that mismatch shifts everything after the
      // mark by a column.
      const mark = out === "success" ? "✓" : out === "failure" ? "✗" : "·";
      const subj = String(e.commit_subject ?? "").trim();
      const subjPart = subj ? ` · ${subj}` : "";
      return `${t}  step ${e.step} ${mark} ${dur} · ${cost}${sha ? ` · ${sha}` : ""}${subjPart}`;
    }
    case "step_failed":
      return `${t}  step ${e.step} failed: ${String(e.category ?? "unknown")}`;
    case "pause_enter":
      return `${t}  pause: ${String(e.reason ?? "")} (${String(e.window ?? "")})`;
    case "pause_exit":
      return `${t}  resume: ${String(e.wake_reason ?? "")}`;
    case "escalate":
      return `${t}  escalate: ${String(e.reason ?? "")}`;
    case "guardrail_trip":
      return `${t}  guardrail: ${String(e.which ?? "")} = ${String(e.actual ?? "")}`;
    case "usage_degraded":
      return `${t}  usage degraded: ${String(e.reason ?? "")}`;
    case "done":
      return `${t}  done · ${String(e.final_commit_sha ?? "").slice(0, 7)}`;
    default:
      return "";
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function formatDurationShort(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${String(r).padStart(2, "0")}s`;
}

async function handleEscalation(
  state: CcloopState,
  paths: ReturnType<typeof runtimePaths>,
  cwd: string,
  abortSignal: AbortSignal,
  readMenuKey: (
    allowed: ReadonlyArray<MenuKey>,
    abortSignal: AbortSignal,
  ) => Promise<MenuKey>,
): Promise<"continue" | "quit"> {
  const key = await readMenuKey(["c", "r", "e", "q"], abortSignal);
  if (abortSignal.aborted) return "quit";
  const lastGreen = await findLastGreenSha(paths.steps);
  const action = decideEscalationKey(key, state, lastGreen);
  switch (action.kind) {
    case "quit":
      return "quit";
    case "continue":
      resetForContinue(state);
      await writeState(paths.state, state);
      return "continue";
    case "revert":
      try {
        await hardReset(cwd, action.sha);
      } catch (err) {
        process.stderr.write(`\nccloop: revert failed: ${(err as Error).message}\n`);
        return "quit";
      }
      resetForContinue(state);
      await writeState(paths.state, state);
      return "continue";
    case "edit_spec": {
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const r = spawnSync(editor, [join(cwd, SPEC_FILENAME)], { stdio: "inherit" });
      if (r.status !== 0) {
        process.stderr.write(`\nccloop: editor exited ${r.status}; staying in escalated state.\n`);
        return "quit";
      }
      resetForContinue(state);
      await writeState(paths.state, state);
      return "continue";
    }
  }
}

/**
 * §10.5 — guardrail-trip terminal screen. `q` quits; `e` opens the
 * editor on `ccloop.toml` so the user can raise the limit, then exits
 * so they can resume with `ccloop run --continue`.
 */
async function handleGuardrailTrip(
  cwd: string,
  abortSignal: AbortSignal,
  readMenuKey: (
    allowed: ReadonlyArray<MenuKey>,
    abortSignal: AbortSignal,
  ) => Promise<MenuKey>,
): Promise<void> {
  const key = await readMenuKey(["q", "e"], abortSignal);
  if (abortSignal.aborted || key === "q") return;
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const r = spawnSync(editor, [join(cwd, CONFIG_FILENAME)], { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(`\nccloop: editor exited ${r.status}.\n`);
    return;
  }
  process.stderr.write(
    `\nccloop: ${CONFIG_FILENAME} edited. Resume with \`ccloop run --continue\`.\n`,
  );
}

function buildView(
  state: CcloopState,
  cwd: string,
  usage: UsageClient | null,
  events: string[],
  nowContent: import("../tui/types.ts").TurnEvent[],
  heartbeat: "●" | "○",
  recent: import("../loop/stepRecord.ts").StepRecord[],
  finalCommitSha: string,
  focus: import("../tui/types.ts").FocusTarget = "now",
  interrupting = false,
  cadenceWait: { startedAt: string; totalMs: number } | null = null,
): TuiViewModel {
  const snapshot = usage?.lastSnapshot() ?? null;
  return project({
    state,
    cwd,
    usage: snapshot,
    recent,
    events,
    nowContent,
    focus,
    heartbeat,
    interrupting,
    cadenceWait,
    now: new Date(),
    finalCommitSha,
  });
}
