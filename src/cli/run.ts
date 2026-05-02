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
import { createPauseGate } from "../loop/pauseGate.ts";
import { EventBus } from "../loop/eventBus.ts";
import { UsageClient } from "../usage/client.ts";
import { loadOAuthToken } from "../auth/loadToken.ts";
import { Dashboard, type MenuKey } from "../tui/Dashboard.tsx";
import { project } from "../tui/projector.ts";
import { EMPTY_VIEW } from "../tui/types.ts";
import type { TuiViewModel } from "../tui/types.ts";
import type { CcloopState } from "../state/state.ts";
import { findLastGreenSha, loadRecentSteps } from "../state/stepLoader.ts";
import { EventLogger, loadRecentEvents } from "../state/events.ts";
import { buildRecap } from "./recap.ts";
import { parseChecklist } from "../spec/checklist.ts";
import { readFile } from "node:fs/promises";
import { VERSION } from "../build-info.ts";
import { clearSessionForReorientation, decideEscalationKey, resetForContinue } from "../loop/escalation.ts";
import { hardReset } from "../loop/git.ts";
import { writeState } from "../state/state.ts";
import { spawnSync } from "node:child_process";

const TUI_TICK_MS = 100;
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

  // Honor --no-color via the standard env var. Ink (and any other
  // chalk-aware writer) reads NO_COLOR at render time. Set it early
  // so the first render in non-TTY echo path is also plain.
  if (flags.noColor) process.env.NO_COLOR = "1";

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

  // §11.5 instance_start. Persist as soon as state is loaded so
  // events.jsonl carries one entry per process lifetime — lets
  // post-mortem tools count "this run had N instances" and
  // distinguish a single 8h session from 8 × 1h resumes.
  const lifecycleEvents = new EventLogger(paths.events);
  let instanceStartEmitted = false;
  try {
    const headSha = await import("../loop/git.ts").then((m) => m.headSha(cwd));
    await lifecycleEvents.append({
      run_id: state.run_id,
      step: state.current_step,
      type: "instance_start",
      ccloop_version: VERSION,
      cwd,
      git_sha: String(headSha),
    });
    instanceStartEmitted = true;
  } catch {
    // Don't let event-log issues block startup.
  }

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
        // Persist a durable marker. Pairs with the prior-crash
        // detection in the recap: an unpaired instance_start tells
        // us "prior process died"; this event tells us "and the
        // prior process had unsaved work we picked up into commit
        // X." Best-effort — log issues must not block resume.
        try {
          await lifecycleEvents.append({
            run_id: state.run_id,
            step: state.current_step,
            type: "recovery_commit",
            commit_sha: String(r.sha),
            commit_subject: r.subject,
          });
        } catch {
          // Non-fatal: recovery committed; event-log write failed.
        }
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

  // 9. TUI: pure-projection render loop.
  //
  // The tick rebuilds the view from the current state on every fire
  // and rerenders unconditionally. Ink's diff renderer makes a no-op
  // rerender free; with the alt-screen + Frame fixes in place, there
  // are no flicker concerns at 4 Hz.
  //
  // History: an earlier design gated rerenders on a `viewDirty` flag
  // that bus subscribers had to set. Direct state mutations
  // (applyEscalation, applyPause, …) emit no bus event, which left
  // the view-update path silently divergent from the state machine
  // for up to one heartbeat. That produced a class of bugs ("the
  // ESCALATED screen is up but the menu keys aren't wired" being the
  // most visible). Single source of truth — current `state` — and a
  // single render path eliminates the class entirely.
  // Prefill the log pane from events.jsonl so `--continue` doesn't
  // open to a blank screen; the operator can see what happened in the
  // prior session(s) before the next step fires. Bus events appended
  // live take over from there.
  //
  // Parallelize the three startup reads — events.jsonl, recent step
  // records, SPEC.md checklist — they're independent and the recap
  // path needs all three. Saves measurable ms on resume; also dedupes
  // the SPEC.md read that previously happened twice (once for recap,
  // once for the dashboard's cached count).
  const [priorEvents, priorStepsForRecap, initialChecklist] = await Promise.all([
    loadRecentEvents(paths.events, LOG_CAP),
    isResume
      ? loadRecentSteps(paths.steps, RECENT_STEPS_CAP)
      : Promise.resolve<import("../loop/stepRecord.ts").StepRecord[]>([]),
    readChecklist(join(cwd, SPEC_FILENAME)),
  ]);
  // Structured event buffer feeds the unified Transcript pane. The
  // projector promotes each entry to a typed visual block; the
  // non-TTY echo path below stringifies via eventToLine for log files.
  let logBuffer: import("../tui/types.ts").LifecycleEntry[] = priorEvents
    .map((e) => e as import("../tui/types.ts").LifecycleEntry)
    .filter((e) => eventToLine(e as { ts: string; type: string } & Record<string, unknown>).length > 0);

  // Wake-up recap: when resuming, print a one-screen overnight summary
  // to stderr before the alt-screen takes over. Lands in scrollback once
  // ccloop exits, so the operator can see what happened without
  // round-tripping to events.jsonl.
  if (isResume) {
    const recap = buildRecap({
      steps: priorStepsForRecap, events: priorEvents,
      now: new Date(), checklist: initialChecklist,
    });
    if (recap) process.stderr.write(recap);
  }
  let nowBuffer: import("../tui/types.ts").TurnEvent[] = [];
  // Live peak input tokens for the in-flight step. Reset on
  // step_start, walked up by usage_tick events from the driver, and
  // passed to the projector so the context bar can advance every
  // turn instead of only at step_end.
  let liveStepPeakTokens = 0;
  let heartbeat: "●" | "○" = "●";
  let lastHeartbeatToggleMs = Date.now();
  let finalCommitSha = "";
  let cachedRecent: import("../loop/stepRecord.ts").StepRecord[] = [];
  let stepsDirty = true;
  // Refreshed on step_end so the dashboard reflects whatever Claude
  // just ticked off without polling SPEC.md every tick. Initialised
  // from the parallel read above — no second SPEC.md read.
  let cachedChecklist: { done: number; total: number } = initialChecklist;
  let checklistDirty = false;
  let interrupting = false;
  let firstInterruptAt = 0;
  let cadenceWait: { startedAt: string; totalMs: number } | null = null;
  // Detached overnight runs (`nohup` or stdout redirect) hit non-TTY.
  // The TUI is a no-op there — see the alt-screen / Ink gates below
  // — so we instead echo each durable event line to stderr so the
  // log file has some signal beyond the startup recap. events.jsonl
  // remains the canonical structured surface.
  const stdoutIsTty = Boolean(process.stdout.isTTY);
  bus.subscribe((e) => {
    if (e.type === "stream_chunk") {
      // Mutable push: was `[...nowBuffer, e.turn]` which is O(n²)
      // across the lifetime of a step. A heavy step can emit
      // thousands of chunks; the spread re-allocated and copied the
      // whole buffer on each one. Dashboard isn't memoized — it
      // re-renders from `view` identity on every tick, not from
      // nowContent identity — so in-place push is safe.
      nowBuffer.push(e.turn);
      return;
    }
    if (e.type === "cadence_wait_enter") {
      cadenceWait = { startedAt: e.started_at, totalMs: e.total_ms };
      return;
    }
    if (e.type === "cadence_wait_exit") {
      cadenceWait = null;
      return;
    }
    if (e.type === "step_start") {
      nowBuffer = [];
      liveStepPeakTokens = 0;
    }
    if (e.type === "usage_tick") {
      liveStepPeakTokens = e.peak_input_tokens;
    }
    const line = eventToLine(e);
    if (line) {
      logBuffer = [...logBuffer, e as unknown as import("../tui/types.ts").LifecycleEntry].slice(-LOG_CAP);
      if (!stdoutIsTty) process.stderr.write(line + "\n");
    }
    if (e.type === "step_end") { stepsDirty = true; checklistDirty = true; }
    if (e.type === "done" && "final_commit_sha" in e) {
      finalCommitSha = String(e.final_commit_sha);
    }
  });
  // Closure-shared menu key handler. Set during ESCALATED /
  // GUARDRAIL_TRIP prompts; the tick threads it through Dashboard
  // props on every render so useMenuKey has a current handler.
  let menuKeyHandler: ((key: MenuKey) => void) | null = null;
  // Per-instance operator pause toggle. In-memory only — restarting
  // ccloop resumes running. The TUI binds `p` to `pauseGate.toggle`;
  // the orchestrator parks at the top of the next loop iteration if
  // the gate is set.
  const pauseGate = createPauseGate();
  // Repaint immediately when the gate flips so the operator gets
  // visual feedback on press, not on the next tick. Defer via
  // setTimeout(0) — onChange fires inside Ink's useInput handler
  // and rerendering inside the same React render call stack is
  // unsafe.
  pauseGate.onChange(() => {
    if (stdoutIsTty) setTimeout(() => renderNow(true), 0);
  });
  const onInterrupt = (): void => {
    const now = Date.now();
    if (interrupting && now - firstInterruptAt < FORCE_EXIT_WINDOW_MS) {
      // Second press within the grace window — give up on graceful
      // shutdown. Restore terminal and bail.
      ink?.unmount();
      leaveAltScreen();
      process.exit(130);
    }
    interrupting = true;
    firstInterruptAt = now;
    aborter.abort();
  };

  let view: TuiViewModel = { ...EMPTY_VIEW, cwd, runId: state.run_id, step: state.current_step };
  // Detached overnight runs (`nohup ccloop run > log.txt 2>&1 &` or
  // CI) hit a non-TTY stdout. Skip the entire TUI in that mode —
  // Ink would otherwise repaint the dashboard frame to the log file
  // 4× per second. events.jsonl + the wake-up recap are the durable
  // surfaces in non-TTY; escalation/guardrail-trip auto-quit since
  // there's no way to read menu keys without raw mode.
  const enterAltScreen = (): void => {
    if (stdoutIsTty) process.stdout.write("\x1b[?1049h\x1b[?25l");
  };
  const leaveAltScreen = (): void => {
    if (stdoutIsTty) process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  enterAltScreen();
  process.on("exit", leaveAltScreen);

  const ink = stdoutIsTty
    ? render(React.createElement(Dashboard, {
        view, onInterrupt,
        onTogglePause: () => { pauseGate.toggle(); },
      }), {
        exitOnCtrlC: false,
        // Ink 6 flicker mitigations:
        //  - incrementalRendering: only emit ANSI for changed lines
        //    instead of clear+rewrite of the whole frame region. This
        //    is the primary fix for the flicker we saw on non-change
        //    ticks; combined with the synchronized-output protocol
        //    (DEC mode 2026, automatic in supporting terminals) the
        //    frame swap becomes atomic.
        //  - concurrent: opt into React 19's concurrent rendering;
        //    enables future use of useDeferredValue / useTransition
        //    for streaming work. Has no immediate behavioral effect
        //    here but makes the renderer interruptible.
        //  - maxFps: defaults to 30 already; explicit so the cap is
        //    visible at the call site. Our tick is 10Hz plus a
        //    skip-if-unchanged guard, well under the cap.
        incrementalRendering: true,
        concurrent: true,
        maxFps: 30,
      })
    : null;
  // Ink writes the full frame on every rerender() call regardless of
  // whether the output bytes actually differ — each write is a
  // clear+rewrite of the frame region, which is what shows up as
  // flicker. The signature collapses idle ticks (only Date.now()
  // changed) to zero paints. Quantize anything time-derived to its
  // visible granularity (1s for heartbeat / countdown / elapsed) so
  // sub-second ticks don't bust the cache.
  let lastSig = "";
  const renderNow = (force = false): void => {
    if (!ink) return;
    view = buildView(
      state, cwd, usageClient, logBuffer, nowBuffer, heartbeat,
      cachedRecent, finalCommitSha,
      undefined, interrupting, cadenceWait, cachedChecklist,
      pauseGate.isPaused(),
      config.claude.model,
      liveStepPeakTokens,
    );
    if (!force) {
      const cadenceS = view.cadenceWait
        ? Math.floor((Date.now() - Date.parse(view.cadenceWait.startedAt)) / 1000)
        : -1;
      const sig = [
        view.state, view.step, view.heartbeat,
        view.transcript.length,
        Math.floor(view.elapsedMs / 1000),
        cadenceS,
        view.usage?.five_hour.utilization ?? "",
        view.usage?.seven_day.utilization ?? "",
        view.checklist ? `${view.checklist.done}/${view.checklist.total}` : "",
        view.rollingCostUsd.toFixed(4),
        view.rollingTokensIn, view.rollingTokensOut,
        view.averageCacheHitRate.toFixed(3), view.cacheLowStreak,
        view.lastContextTokens, view.contextWindowTokens,
        view.focus, view.interrupting,
        view.pause?.reason ?? "", view.pause?.until ?? "",
        view.escalation?.reason ?? "",
        view.guardrail?.which ?? "", view.guardrail?.actual ?? "",
        view.done?.finalCommitSha ?? "",
        menuKeyHandler ? 1 : 0,
      ].join("|");
      if (sig === lastSig) return;
      lastSig = sig;
    }
    ink.rerender(React.createElement(Dashboard, {
      view, onMenuKey: menuKeyHandler ?? undefined, onInterrupt,
      onTogglePause: () => { pauseGate.toggle(); },
    }));
  };
  if (usageClient) void usageClient.get();
  const usagePollTimer = usageClient
    ? setInterval(() => { void usageClient.get(); }, 30_000)
    : null;
  const tickTimer = stdoutIsTty
    ? setInterval(async () => {
        if (stepsDirty) {
          cachedRecent = await loadRecentSteps(paths.steps, RECENT_STEPS_CAP);
          stepsDirty = false;
        }
        if (checklistDirty) {
          cachedChecklist = await readChecklist(join(cwd, SPEC_FILENAME));
          checklistDirty = false;
        }
        const now = Date.now();
        if (now - lastHeartbeatToggleMs >= HEARTBEAT_INTERVAL_MS) {
          heartbeat = heartbeat === "●" ? "○" : "●";
          lastHeartbeatToggleMs = now;
        }
        renderNow();
      }, TUI_TICK_MS)
    : null;

  const readMenuKey = (
    allowed: ReadonlyArray<MenuKey>,
    abortSignal: AbortSignal,
  ): Promise<MenuKey> => {
    // Non-TTY can't read menu keys (no raw mode). Auto-quit so the
    // run terminates cleanly with the relevant exit code; the
    // operator resumes via `--continue` after addressing the cause.
    if (!ink) return Promise.resolve<MenuKey>("q");
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
      // Force an immediate paint with the new handler attached so
      // the user doesn't wait up to one tick for the menu to become
      // responsive. State has already mutated upstream — renderNow
      // reads `state` fresh, so the correct screen + handler land
      // in a single rerender.
      renderNow(true);
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
        heartbeatUrl: config.notify.heartbeat_url,
        pauseGate,
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
        // Audit trail: record what the operator did at the menu so a
        // post-mortem (or the wake-up recap) can answer "what
        // recovery action did I take at 2am?" without inferring from
        // git log + state diffs. Best-effort.
        try {
          await lifecycleEvents.append({
            run_id: state.run_id,
            step: state.current_step,
            type: "escalation_resolved",
            action,
          });
        } catch {
          // Non-fatal.
        }
        if (action === "quit") { exitCode = 5; resolved = true; }
        // continue / revert / edit_spec → loop again with reset state
      }
    }
  } catch (err) {
    process.stderr.write(`\nccloop: fatal error: ${(err as Error).message}\n`);
    exitCode = 1;
  } finally {
    if (tickTimer) clearInterval(tickTimer);
    if (usagePollTimer) clearInterval(usagePollTimer);
    if (ink) {
      cachedRecent = await loadRecentSteps(paths.steps, RECENT_STEPS_CAP);
      menuKeyHandler = null; // suppress key wiring on the final paint
      renderNow(true);
      ink.unmount();
    }
    leaveAltScreen();
    process.off("exit", leaveAltScreen);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (release) await release();
    // §11.5 instance_exit. Best-effort — don't let log-write
    // failures change the exit code that the user actually cares
    // about. The reason field is the dominant outcome from runLoop;
    // a fatal error path that didn't go through runLoop falls back
    // to "fatal_error".
    if (instanceStartEmitted) {
      try {
        await lifecycleEvents.append({
          run_id: state.run_id,
          step: state.current_step,
          type: "instance_exit",
          reason: exitReasonFromCode(exitCode),
          exit_code: exitCode,
        });
      } catch {
        // Best-effort.
      }
    }
  }
  return exitCode;
}

function exitReasonFromCode(code: number): string {
  // Mirror the SPEC §12.6 / §0 exit-code table in human-readable form.
  switch (code) {
    case 0: return "done";
    case 1: return "fatal_error";
    case 2: return "auth_missing";
    case 3: return "lock_held";
    case 4: return "guardrail_trip";
    case 5: return "escalated";
    case 130: return "sigint";
    case 143: return "sigterm";
    default: return `exit_${code}`;
  }
}

async function readChecklist(specPath: string): Promise<{ done: number; total: number }> {
  try {
    const text = await readFile(specPath, "utf8");
    return parseChecklist(text);
  } catch {
    return { done: 0, total: 0 };
  }
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
    case "operator_pause_enter":
      return `${t}  pause: operator`;
    case "operator_pause_exit":
      return `${t}  resume: operator`;
    case "escalate":
      return `${t}  escalate: ${String(e.reason ?? "")}`;
    case "guardrail_trip":
      return `${t}  guardrail: ${String(e.which ?? "")} = ${String(e.actual ?? "")}`;
    case "usage_degraded":
      return `${t}  usage degraded: ${String(e.reason ?? "")}`;
    case "cache_warning": {
      const rate = (numberOr(e.rate, 0) * 100).toFixed(0);
      return `${t}  cache hit rate ${rate}% for ${numberOr(e.streak, 0)} steps in a row`;
    }
    case "notification_sent": {
      const channel = String(e.channel ?? "?");
      const ok = e.ok === true;
      const status = e.status === null || e.status === undefined ? "—" : String(e.status);
      const detail = ok ? `ok (${status})` : `failed (${e.error ?? status})`;
      return `${t}  notify ${channel}: ${detail}`;
    }
    case "instance_start": {
      const v = e.ccloop_version ? `v${e.ccloop_version}` : "";
      const sha = String(e.git_sha ?? "").slice(0, 7);
      const tail = [v, sha ? `@${sha}` : ""].filter(Boolean).join(" ");
      return `${t}  instance start${tail ? ` · ${tail}` : ""}`;
    }
    case "instance_exit":
      return `${t}  instance exit · ${String(e.reason ?? "?")} (exit ${e.exit_code ?? "?"})`;
    case "recovery_commit": {
      const sha = String(e.commit_sha ?? "").slice(0, 7);
      const subj = String(e.commit_subject ?? "").trim();
      const tail = subj ? ` · ${subj}` : "";
      return `${t}  recovery commit ${sha}${tail}`;
    }
    case "escalation_resolved":
      return `${t}  escalation resolved · ${String(e.action ?? "?")}`;
    case "session_rotated": {
      const prev = String(e.previous_session_id ?? "");
      const prevTail = prev ? ` (was ${prev.slice(0, 8)})` : "";
      const reason = String(e.reason ?? "?");
      const tokTail = e.reason === "context_threshold" && e.context_tokens && e.context_window
        ? ` · ${numberOr(e.context_tokens, 0)}/${numberOr(e.context_window, 0)} tokens`
        : "";
      return `${t}  session rotated · ${reason}${tokTail}${prevTail}`;
    }
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

type EscalationOutcome = "continue" | "revert" | "edit_spec" | "quit";

async function handleEscalation(
  state: CcloopState,
  paths: ReturnType<typeof runtimePaths>,
  cwd: string,
  abortSignal: AbortSignal,
  readMenuKey: (
    allowed: ReadonlyArray<MenuKey>,
    abortSignal: AbortSignal,
  ) => Promise<MenuKey>,
): Promise<EscalationOutcome> {
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
      clearSessionForReorientation(state);
      await writeState(paths.state, state);
      return "revert";
    case "edit_spec": {
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const r = spawnSync(editor, [join(cwd, SPEC_FILENAME)], { stdio: "inherit" });
      if (r.status !== 0) {
        process.stderr.write(`\nccloop: editor exited ${r.status}; staying in escalated state.\n`);
        return "quit";
      }
      resetForContinue(state);
      clearSessionForReorientation(state);
      await writeState(paths.state, state);
      return "edit_spec";
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
  events: import("../tui/types.ts").LifecycleEntry[],
  nowContent: import("../tui/types.ts").TurnEvent[],
  heartbeat: "●" | "○",
  recent: import("../loop/stepRecord.ts").StepRecord[],
  finalCommitSha: string,
  focus: import("../tui/types.ts").FocusTarget = "transcript",
  interrupting = false,
  cadenceWait: { startedAt: string; totalMs: number } | null = null,
  checklist: { done: number; total: number } | null = null,
  operatorPaused = false,
  model = "",
  liveStepPeakTokens = 0,
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
    checklist,
    now: new Date(),
    finalCommitSha,
    operatorPaused,
    model,
    liveStepPeakTokens,
  });
}
