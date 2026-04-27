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
  type IsoTimestamp, type Sha,
  asSha, isoFromDate,
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
import { type StepResult } from "../sdk/types.ts";
import { autoCommit, headDiffHash, headSha } from "./git.ts";
import { classifyStep } from "./classify.ts";
import { deriveCommitSubject } from "./commitMessage.ts";
import { checkGuardrails } from "./guardrails.ts";
import { buildStepRecord, writeStepRecord } from "./stepRecord.ts";
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
      outcome: "success" | "failure" | "no-op";
    })
  | (EventBase & { type: "step_failed"; category: string; error_excerpt: string })
  | (EventBase & { type: "done"; final_commit_sha: Sha })
  | (EventBase & { type: "guardrail_trip"; which: string; limit: unknown; actual: unknown })
  | (EventBase & { type: "escalate"; reason: string })
  | (EventBase & { type: "pause_enter"; reason: string; until: IsoTimestamp; window: string })
  | (EventBase & { type: "pause_exit"; wake_reason: string });

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
    };
  }

  async loadOrInitState(): Promise<CcloopState> {
    const existing = await readState(this.paths.state);
    if (existing) return existing;
    const s = freshState(this.deps.now());
    await writeState(this.paths.state, s);
    return s;
  }

  /** Emit to bus and append durably to events.jsonl. */
  private async emit(event: Omit<DriverEvent, "ts">): Promise<void> {
    const enriched = { ...event, ts: isoFromDate(this.deps.now()) } as DriverEvent;
    if (this.bus) this.bus.emit(enriched);
    await this.events.append(enriched);
  }

  /** Check `./DONE.md` per §5.2. */
  private isDone(): boolean {
    return existsSync(join(this.cwd, DONE_FILENAME));
  }

  /**
   * Execute exactly one step end-to-end. Returns a status describing
   * what happened. Guardrail / DONE checks run first (pre-flight); on
   * a successful or failed step, post-flight runs (record, commit,
   * state persist) before returning.
   */
  async stepOnce(state: CcloopState, abortSignal?: AbortSignal): Promise<StepStatus> {
    if (this.isDone()) {
      const sha = await this.deps.headSha(this.cwd);
      state.state = "done";
      await writeState(this.paths.state, state);
      await this.emit({
        run_id: state.run_id,
        step: state.current_step,
        type: "done",
        final_commit_sha: sha,
      });
      return { kind: "done", finalCommitSha: sha };
    }

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

    const promptVars = {
      spec: await readFileOrEmpty(join(this.cwd, SPEC_FILENAME)),
      progress: await readFileOrEmpty(this.paths.progress),
      last_error: state.consecutive_failures > 0 && state.escalation === null
        ? `# Previous step failed.\n\nWork through the issue and try again.\n`
        : "",
      step: state.current_step,
    };
    const tpl = await loadPromptTemplate(this.config.prompt.template_path);
    const prompt = renderPrompt(tpl, promptVars);

    await this.emit({
      run_id: state.run_id,
      step: state.current_step,
      type: "step_start",
    });

    const startedAt = this.deps.now();
    const ac = abortSignal
      ? signalToController(abortSignal)
      : undefined;
    const result = await this.deps.runStep({
      prompt,
      cwd: this.cwd,
      config: this.config,
      resumeSessionId: state.session_id,
      abortController: ac,
    });
    const endedAt = this.deps.now();

    const classified = classifyStep(result);

    let commitSha: Sha = asSha("");
    let commitSubject = "";
    let outcome: "success" | "failure" | "no-op" = "failure";
    let commitFailure: { category: string; excerpt: string } | null = null;

    if (classified.outcome === "success") {
      commitSubject = deriveCommitSubject(result.final_text, state.current_step);
      try {
        const c = await this.deps.autoCommit(this.cwd, commitSubject);
        commitSha = c.sha;
        outcome = c.committed ? "success" : "no-op";
      } catch (err) {
        outcome = "failure";
        commitFailure = { category: "commit", excerpt: (err as Error).message };
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
    } else {
      state.consecutive_failures = 0;
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
    state.wall_clock_ms += endedAt.getTime() - startedAt.getTime();

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

export function isLoopStuck(hashes: readonly string[], n: number): boolean {
  if (n <= 1) return false;
  if (hashes.length < n) return false;
  const tail = hashes.slice(-n);
  return tail.every((h) => h === tail[0]);
}
