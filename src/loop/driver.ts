/**
 * §4 step-loop state machine. The driver is the only place that
 * mutates `state.json`; everything else takes a state snapshot.
 *
 * The driver is structured so it can be stepped one cycle at a time
 * for tests, or run to completion in production.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CcloopConfig } from "../config/schema.ts";
import { type EventBase, EventLogger } from "../state/events.ts";
import {
  type IsoTimestamp, type SessionId, type Sha,
  asSessionId, asSha, isoFromDate,
} from "../branded.ts";
import { type RuntimePaths, DONE_FILENAME, SPEC_FILENAME } from "../state/paths.ts";
import {
  type CcloopState,
  freshState,
  readState,
  writeState,
} from "../state/state.ts";
import { loadPromptTemplate, renderPrompt } from "../sdk/prompt.ts";
import { runStep } from "../sdk/runStep.ts";
import { StreamParser } from "../sdk/streamParser.ts";
import { type StepResult, emptyUsage } from "../sdk/types.ts";
import { makeApprover } from "../sandbox/approver.ts";
import type { TurnEvent } from "../tui/types.ts";
import { autoCommit, headDiffHash, headSha } from "./git.ts";
import { type FailureCategory, type StepFailure, capExcerpt, classifyStep } from "./classify.ts";
import { runGate } from "./gate.ts";
import { deriveCommitSubject } from "./commitMessage.ts";
import { checkGuardrails } from "./guardrails.ts";
import { type StepRecord, buildStepRecord, writeStepRecord } from "./stepRecord.ts";
import { type EventBus } from "./eventBus.ts";

export type DriverEvent =
  | (EventBase & { type: "step_start" })
  | (EventBase & {
      type: "step_end";
      subtype: string;
      stop_reason: string | null;
      duration_ms: number;
      cost_usd: number;
      commit_sha: Sha;
      commit_subject: string;
      outcome: "success" | "failure" | "no-op";
    })
  | (EventBase & { type: "step_failed"; category: FailureCategory; error_excerpt: string })
  | (EventBase & { type: "done"; final_commit_sha: Sha })
  | (EventBase & { type: "guardrail_trip"; which: string; limit: unknown; actual: unknown })
  | (EventBase & { type: "escalate"; reason: string })
  | (EventBase & { type: "pause_enter"; reason: string; until: IsoTimestamp; window: string })
  | (EventBase & { type: "pause_exit"; wake_reason: string })
  | (EventBase & { type: "usage_degraded"; status: number | null; reason: string })
  | (EventBase & { type: "cache_warning"; streak: number; rate: number })
  | (EventBase & {
      type: "notification_sent";
      channel: "push" | "webhook";
      status: number | null;
      ok: boolean;
      error?: string;
    })
  | (EventBase & { type: "stream_chunk"; turn: TurnEvent })
  | (EventBase & { type: "cadence_wait_enter"; started_at: IsoTimestamp; total_ms: number })
  | (EventBase & { type: "cadence_wait_exit" });

export type StepStatus =
  | { kind: "done"; finalCommitSha: Sha }
  | { kind: "guardrail_trip"; which: string; limit: number | string; actual: number | string }
  | { kind: "escalated"; reason: string }
  | { kind: "paused"; until: IsoTimestamp; reason: string }
  | { kind: "ran"; result: StepResult; outcome: "success" | "failure" | "no-op" };

export interface DriverDeps {
  /** Test seam — pluggable runStep for unit tests. */
  runStep?: typeof runStep;
  /** Test seam — provide a fixed clock. */
  now?: () => Date;
  /** Test seam — optional override of git commit. */
  autoCommit?: typeof autoCommit;
  headDiffHash?: typeof headDiffHash;
  headSha?: typeof headSha;
  /** Test seam — optional override of gate command runner. */
  runGate?: typeof runGate;
}

export class LoopDriver {
  private readonly events: EventLogger;
  private readonly bus?: EventBus<DriverEvent>;
  private readonly deps: Required<DriverDeps>;

  constructor(
    private readonly cwd: string,
    private readonly paths: RuntimePaths,
    private readonly config: CcloopConfig,
    bus?: EventBus<DriverEvent>,
    deps: DriverDeps = {},
  ) {
    this.events = new EventLogger(paths.events);
    this.bus = bus;
    this.deps = {
      runStep: deps.runStep ?? runStep,
      now: deps.now ?? (() => new Date()),
      autoCommit: deps.autoCommit ?? autoCommit,
      headDiffHash: deps.headDiffHash ?? headDiffHash,
      headSha: deps.headSha ?? headSha,
      runGate: deps.runGate ?? runGate,
    };
  }

  async loadOrInitState(): Promise<CcloopState> {
    const existing = await readState(this.paths.state);
    if (existing) return existing;
    const s = freshState(this.deps.now());
    await writeState(this.paths.state, s);
    return s;
  }

  /** Emit to bus and (for durable types) append to events.jsonl.
   *  `stream_chunk` is bus-only — writing every assistant text + tool
   *  use to the durable log would balloon it without paying rent. */
  private async emit(event: Omit<DriverEvent, "ts">): Promise<void> {
    const enriched = { ...event, ts: isoFromDate(this.deps.now()) } as DriverEvent;
    if (this.bus) this.bus.emit(enriched);
    if (
      event.type !== "stream_chunk" &&
      event.type !== "cadence_wait_enter" &&
      event.type !== "cadence_wait_exit"
    ) {
      await this.events.append(enriched);
    }
  }

  /** Check `./DONE.md` per §5.2. */
  private isDone(): boolean {
    return existsSync(join(this.cwd, DONE_FILENAME));
  }

  /** Record a failure that occurred *before* `stepOnce` could run
   *  (e.g. the SDK threw synchronously on `query` / `resume`). The
   *  orchestrator catches these and routes through this method so
   *  the bus, events.jsonl, and state.json all see the failure —
   *  without it, an SDK init failure was invisible to the TUI events
   *  pane and the wake-up recap. Does *not* touch `current_step` or
   *  write a step record (we have no usage / num_turns / cost data
   *  for a step that never started). */
  async recordSdkInitFailure(state: CcloopState, message: string): Promise<StepFailure> {
    const failure: StepFailure = {
      category: "sdk_init",
      excerpt: capExcerpt(message),
    };
    state.consecutive_failures += 1;
    state.last_failure = failure;
    await writeState(this.paths.state, state);
    await this.emit({
      run_id: state.run_id,
      step: state.current_step,
      type: "step_failed",
      category: failure.category,
      error_excerpt: failure.excerpt,
    });
    return failure;
  }

  /** Public DONE pre-flight: returns a `done` StepStatus if `./DONE.md`
   *  exists, applying the state transition and emitting the `done`
   *  event as a side effect. Returns null otherwise. The orchestrator
   *  calls this both at step pre-flight (via `stepOnce`) and again
   *  post-step before cadence sleep, so a step that creates DONE.md
   *  doesn't have to wait out the next cadence window before the loop
   *  notices.
   *
   *  `forStep` overrides the step number on the emitted event. The
   *  post-cadence call passes the step that just completed (rather
   *  than the already-incremented `state.current_step`) so the
   *  events.jsonl `done` line attributes the achievement to the
   *  step whose work created `DONE.md`, not the would-be next step. */
  async checkDoneTransition(
    state: CcloopState,
    forStep?: number,
  ): Promise<StepStatus | null> {
    if (!this.isDone()) return null;
    const sha = await this.deps.headSha(this.cwd);
    state.state = "done";
    await writeState(this.paths.state, state);
    await this.emit({
      run_id: state.run_id,
      step: forStep ?? state.current_step,
      type: "done",
      final_commit_sha: sha,
    });
    return { kind: "done", finalCommitSha: sha };
  }

  /**
   * Execute exactly one step end-to-end. Returns a status describing
   * what happened. Guardrail / DONE checks run first (pre-flight); on
   * a successful or failed step, post-flight runs (record, commit,
   * state persist) before returning.
   */
  async stepOnce(state: CcloopState, abortSignal?: AbortSignal): Promise<StepStatus> {
    const done = await this.checkDoneTransition(state);
    if (done) return done;

    const gr = checkGuardrails(this.config.loop, {
      currentStep: state.current_step,
      wallClockMs: state.wall_clock_ms,
    });
    if (gr.trip) {
      state.state = "guardrail_trip";
      state.guardrail_trip = {
        which: gr.which,
        limit: gr.limit,
        actual: gr.actual,
        entered_at: isoFromDate(this.deps.now()),
      };
      await writeState(this.paths.state, state);
      await this.emit({
        run_id: state.run_id,
        step: state.current_step,
        type: "guardrail_trip",
        which: gr.which,
        limit: gr.limit,
        actual: gr.actual,
      });
      return { kind: "guardrail_trip", which: gr.which, limit: gr.limit, actual: gr.actual };
    }

    // Pre-flight 3 (usage gate) is intentionally omitted here — the
    // run.ts entrypoint does it before calling stepOnce. Keeping the
    // driver SDK-only makes it straightforward to test.

    const tpl = await loadPromptTemplate(this.config.prompt.template_path);
    const promptVars = {
      spec: tpl.includes("{{spec}}")
        ? await readFileOrEmpty(join(this.cwd, SPEC_FILENAME))
        : "",
      progress: tpl.includes("{{progress}}")
        ? await readFileOrEmpty(this.paths.progress)
        : "",
      last_error: renderLastError(state),
      step: state.current_step,
    };
    const prompt = renderPrompt(tpl, promptVars);

    await this.emit({
      run_id: state.run_id,
      step: state.current_step,
      type: "step_start",
    });

    const startedAt = this.deps.now();
    // Snapshot HEAD before the SDK runs so autoCommit can distinguish
    // "Claude made no changes" (no-op) from "Claude committed itself"
    // (HEAD advanced even though the tree is clean).
    const preStepHead = await this.deps.headSha(this.cwd);
    // Per-step watchdog. The SDK has no native deadline on its
    // iterator; if a network read stalls mid-stream there's no
    // signal to break the await. The watchdog aborts via the same
    // controller used for SIGINT so the SDK exits its loop, and we
    // synthesize a step_timeout failure result on catch.
    const ac = abortSignal
      ? signalToController(abortSignal)
      : new AbortController();
    let watchdogTimedOut = false;
    const stepTimeoutMs = this.config.claude.step_timeout_seconds * 1000;
    const watchdog = stepTimeoutMs > 0 ? setTimeout(() => {
      watchdogTimedOut = true;
      ac.abort();
    }, stepTimeoutMs) : null;
    const parser = new StreamParser();
    const approver = makeApprover({
      yoloMode: this.config.claude.yolo_mode,
      cwd: this.cwd,
    });
    // True only on the path where the watchdog fired AND runStep
    // threw — i.e. the SDK actually noticed the abort. If the SDK
    // happened to complete its in-flight message before the abort
    // propagated, runStep returns success and we trust that result
    // even though the watchdog flag is set; treating a successful
    // step as a timeout failure would corrupt the audit trail.
    let timedOutAndAborted = false;
    let result: StepResult;
    try {
      result = await this.deps.runStep({
        prompt,
        cwd: this.cwd,
        config: this.config,
        resumeSessionId: state.session_id,
        abortController: ac,
        preToolUseHook: approver,
        step: state.current_step,
        onMessage: (msg) => {
          const ts = isoFromDate(this.deps.now());
          for (const turn of parser.consume(msg, ts)) {
            // Fire-and-forget — emit for stream_chunk only touches the
            // bus, no I/O. Wrapping in a Promise keeps the type checker
            // happy without awaiting on the SDK iterator's hot path.
            void this.emit({
              run_id: state.run_id,
              step: state.current_step,
              type: "stream_chunk",
              turn,
            });
          }
        },
      });
    } catch (err) {
      if (watchdogTimedOut) {
        // Synthesize a failed result so we still write a step record
        // and the next prompt's last_error block carries the timeout.
        result = synthesizeTimeoutResult(state.session_id, stepTimeoutMs);
        timedOutAndAborted = true;
      } else {
        throw err;
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    const endedAt = this.deps.now();

    let classified = classifyStep(result);
    if (timedOutAndAborted) {
      classified = {
        outcome: "failure",
        category: "step_timeout",
        excerpt: `step exceeded claude.step_timeout_seconds (${stepTimeoutMs}ms)`,
      };
    }

    let commitSha: Sha = asSha("");
    let commitSubject = "";
    let outcome: "success" | "failure" | "no-op" = "failure";
    let commitFailure: StepFailure | null = null;

    if (classified.outcome === "success") {
      const gateCmd = this.config.loop.gate_command;
      const gate = gateCmd
        ? await this.deps.runGate({
            cwd: this.cwd,
            command: gateCmd,
            timeoutSeconds: this.config.loop.gate_timeout_seconds,
          })
        : { ok: true as const, exitCode: 0, excerpt: "", timedOut: false };
      if (!gate.ok) {
        outcome = "failure";
        commitFailure = { category: "gate", excerpt: gate.excerpt };
      } else {
        commitSubject = deriveCommitSubject(result.final_text, state.current_step);
        try {
          const c = await this.deps.autoCommit(this.cwd, commitSubject, preStepHead);
          commitSha = c.sha;
          outcome = c.committed ? "success" : "no-op";
        } catch (err) {
          outcome = "failure";
          commitFailure = { category: "commit", excerpt: (err as Error).message };
        }
      }
    }

    const failure =
      classified.outcome === "failure"
        ? { category: classified.category, excerpt: classified.excerpt }
        : commitFailure;

    const rec = buildStepRecord({
      step: state.current_step,
      runId: state.run_id,
      startedAt,
      endedAt,
      outcome,
      subtype: result.subtype,
      stopReason: result.stop_reason,
      sessionId: result.session_id,
      numTurns: result.num_turns,
      usage: result.usage,
      costUsd: result.total_cost_usd,
      commitSha,
      commitSubject,
      failure,
    });
    await writeStepRecord(this.paths, rec);

    if (failure) {
      state.consecutive_failures += 1;
      state.last_failure = failure;
    } else {
      state.consecutive_failures = 0;
      state.last_failure = null;
    }
    if (outcome === "no-op") {
      state.no_progress_count += 1;
    } else if (outcome === "success") {
      state.no_progress_count = 0;
      const dh = await this.deps.headDiffHash(this.cwd);
      if (dh) {
        state.diff_hashes_recent = [
          ...state.diff_hashes_recent.slice(-(this.config.failure.loop_detection_repeats + 2)),
          dh,
        ];
      }
    }
    state.session_id = result.session_id || state.session_id;
    state.steps_since_session_reset += 1;
    state.wall_clock_ms += endedAt.getTime() - startedAt.getTime();

    const cap = this.config.claude.max_steps_per_session;
    if (cap > 0 && state.steps_since_session_reset >= cap) {
      state.session_id = null;
      state.steps_since_session_reset = 0;
    }

    const cacheWarn = trackCacheStreak(state, rec);
    if (cacheWarn) {
      await this.emit({
        run_id: state.run_id,
        step: state.current_step,
        type: "cache_warning",
        streak: cacheWarn.streak,
        rate: cacheWarn.rate,
      });
    }

    if (
      state.consecutive_failures >= this.config.failure.consecutive_failures_before_escalation
    ) {
      state.state = "escalated";
      state.escalation = {
        reason: `${state.consecutive_failures} consecutive failures`,
        trail: [],
        entered_at: isoFromDate(this.deps.now()),
      };
    } else if (state.no_progress_count >= this.config.failure.no_progress_threshold) {
      state.state = "escalated";
      state.escalation = {
        reason: `no_progress (${state.no_progress_count} consecutive no-op steps)`,
        trail: [],
        entered_at: isoFromDate(this.deps.now()),
      };
    } else if (isLoopStuck(state.diff_hashes_recent, this.config.failure.loop_detection_repeats)) {
      state.state = "escalated";
      state.escalation = {
        reason: `loop_detected (same diff ${this.config.failure.loop_detection_repeats}× in a row)`,
        trail: [],
        entered_at: isoFromDate(this.deps.now()),
      };
    }

    state.current_step += 1;

    await writeState(this.paths.state, state);

    await this.emit({
      run_id: state.run_id,
      step: rec.step,
      type: "step_end",
      subtype: result.subtype,
      stop_reason: result.stop_reason,
      duration_ms: rec.duration_ms,
      cost_usd: rec.cost_usd,
      commit_sha: commitSha,
      commit_subject: commitSubject,
      outcome,
    });
    if (failure) {
      await this.emit({
        run_id: state.run_id,
        step: rec.step,
        type: "step_failed",
        category: failure.category,
        error_excerpt: failure.excerpt,
      });
    }
    if (state.state === "escalated") {
      await this.emit({
        run_id: state.run_id,
        step: rec.step,
        type: "escalate",
        reason: state.escalation?.reason ?? "unknown",
      });
      return { kind: "escalated", reason: state.escalation?.reason ?? "unknown" };
    }

    return { kind: "ran", result, outcome };
  }
}

const CACHE_LOW_THRESHOLD = 0.5;
const CACHE_LOW_STREAK_BEFORE_WARN = 3;

/** Update `state.cache_low_streak` from the just-finished step's
 *  cache hit rate (per SPEC §11). Returns warning payload only on the
 *  transition that crosses the threshold — repeated low-rate steps
 *  past the threshold don't re-warn until the streak resets. Steps
 *  with no token usage (e.g. SDK init failures) don't move the
 *  streak; the rate is undefined there. */
function trackCacheStreak(
  state: CcloopState,
  rec: StepRecord,
): { streak: number; rate: number } | null {
  const hasTokens =
    rec.usage.input_tokens +
    rec.usage.cache_read_input_tokens +
    rec.usage.cache_creation_input_tokens > 0;
  if (!hasTokens) return null;
  if (rec.cache_hit_rate < CACHE_LOW_THRESHOLD) {
    state.cache_low_streak += 1;
    if (state.cache_low_streak === CACHE_LOW_STREAK_BEFORE_WARN) {
      return { streak: state.cache_low_streak, rate: rec.cache_hit_rate };
    }
    return null;
  }
  state.cache_low_streak = 0;
  return null;
}

/** Build the prompt's `{{last_error}}` block from state. Empty string
 *  when there's nothing to report; otherwise a short markdown section
 *  with the failure category and excerpt so Claude can course-correct
 *  rather than re-attempting blind. Suppressed once escalation is
 *  active — the operator owns recovery in that mode. */
export function renderLastError(state: CcloopState): string {
  if (state.escalation !== null) return "";
  const lf = state.last_failure;
  if (!lf) return "";
  const trimmed = lf.excerpt.trim();
  if (trimmed.length === 0) {
    return `# Previous step failed (${lf.category}).\n\nWork through the issue and try again.\n`;
  }
  // Use a fence one backtick longer than the longest backtick run in
  // the excerpt — CommonMark requires the closing fence to be at
  // least as long as the opening, and a tool-output excerpt can
  // legitimately contain triple-backtick markdown that would
  // otherwise break the prompt's markdown structure.
  const fence = "`".repeat(Math.max(3, longestBacktickRun(trimmed) + 1));
  const body = `\n\n${fence}\n${trimmed}\n${fence}\n`;
  return `# Previous step failed (${lf.category}).${body}\nWork through the issue and try again.\n`;
}

function longestBacktickRun(s: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

async function readFileOrEmpty(path: string): Promise<string> {
  if (!path || !existsSync(path)) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function signalToController(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", () => ac.abort(), { once: true });
  return ac;
}

function synthesizeTimeoutResult(
  resumeSessionId: SessionId | null,
  timeoutMs: number,
): StepResult {
  return {
    subtype: "error_during_execution",
    stop_reason: null,
    num_turns: 0,
    total_cost_usd: 0,
    duration_ms: timeoutMs,
    usage: emptyUsage(),
    session_id: resumeSessionId ?? asSessionId(""),
    final_text: "",
    errors: [`step timed out after ${timeoutMs}ms`],
  };
}

export function isLoopStuck(hashes: readonly string[], n: number): boolean {
  if (n <= 1) return false;
  if (hashes.length < n) return false;
  const tail = hashes.slice(-n);
  return tail.every((h) => h === tail[0]);
}
