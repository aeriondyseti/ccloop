import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../util/atomic.ts";
import {
  type IsoTimestamp, type RunId, type SessionId, type Sha,
  isoFromDate, newRunId,
} from "../branded.ts";
import { isENOENT } from "../errors.ts";
import type { StepFailure } from "../loop/classify.ts";

export const STATE_SCHEMA_VERSION = 1;

export type RunStateName =
  | "running"
  | "paused"
  | "escalated"
  | "guardrail_trip"
  | "done";

export interface PauseInfo {
  until: IsoTimestamp;
  reason: string;
  window: "five_hour" | "seven_day" | "unknown";
  entered_at: IsoTimestamp;
}

export interface EscalationInfo {
  reason: string;
  trail: unknown[];
  entered_at: IsoTimestamp;
}

export interface GuardrailTripInfo {
  which: "max_steps" | "max_wall_clock" | "dirty_tree";
  limit: number | string;
  actual: number | string;
  entered_at: IsoTimestamp;
}

/** Records the per-run worktree ccloop drives in. Persisted so
 *  `--continue` can recover the worktree path/branch across instances,
 *  and so `done` knows what to fast-forward back into the user's
 *  branch. Absent on legacy runs and on runs with `loop.use_worktree
 *  = false`. */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory (under `.ccloop/`). */
  path: string;
  /** Branch name created for this run, e.g. `ccloop/<run_id>`. */
  branch: string;
  /** Branch the user was on when the run started; the merge target
   *  on `done`. Empty string if the user was in detached HEAD. */
  original_branch: string;
  /** SHA `original_branch` pointed at when the run started. The
   *  fast-forward refuses if the branch has moved since. */
  original_base_sha: Sha;
}

export interface CcloopState {
  schema_version: number;
  run_id: RunId;
  started_at: IsoTimestamp;
  current_step: number;
  wall_clock_ms: number;
  session_id: SessionId | null;
  consecutive_failures: number;
  no_progress_count: number;
  cache_low_streak: number;
  steps_since_session_reset: number;
  diff_hashes_recent: string[];
  state: RunStateName;
  pause: PauseInfo | null;
  escalation: EscalationInfo | null;
  guardrail_trip: GuardrailTripInfo | null;
  last_failure: StepFailure | null;
  worktree: WorktreeInfo | null;
  /** Summary captured from a session right before it was rotated.
   *  Rendered into the next step's prompt as `{{rotation_summary}}`
   *  so the fresh session inherits the model's running picture
   *  instead of starting blank. Cleared after one consumption. */
  rotation_summary: string | null;
}

export class StateError extends Error {}

export function freshState(now: Date = new Date()): CcloopState {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: newRunId(),
    started_at: isoFromDate(now),
    current_step: 1,
    wall_clock_ms: 0,
    session_id: null,
    consecutive_failures: 0,
    no_progress_count: 0,
    cache_low_streak: 0,
    steps_since_session_reset: 0,
    diff_hashes_recent: [],
    state: "running",
    pause: null,
    escalation: null,
    guardrail_trip: null,
    last_failure: null,
    worktree: null,
    rotation_summary: null,
  };
}

export async function readState(path: string): Promise<CcloopState | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return null;
    throw new StateError(`failed to read state: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new StateError(`state.json is not valid JSON: ${(err as Error).message}`);
  }
  return validateState(parsed);
}

export function validateState(raw: unknown): CcloopState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StateError("state.json: top-level must be an object");
  }
  const r = raw as Record<string, unknown>;
  const v = r.schema_version;
  if (typeof v !== "number") {
    throw new StateError("state.json: missing schema_version");
  }
  if (v > STATE_SCHEMA_VERSION) {
    throw new StateError(
      `state.json: schema_version ${v} > supported ${STATE_SCHEMA_VERSION}`,
    );
  }
  // Trust the rest of the shape; catch obvious string/number missing fields.
  const required: ReadonlyArray<[string, "string" | "number"]> = [
    ["run_id", "string"],
    ["started_at", "string"],
    ["current_step", "number"],
    ["wall_clock_ms", "number"],
    ["consecutive_failures", "number"],
    ["no_progress_count", "number"],
    ["state", "string"],
  ];
  for (const [k, t] of required) {
    if (typeof r[k] !== t) {
      throw new StateError(`state.json: field \`${k}\` must be ${t}`);
    }
    // `typeof NaN === "number"` — a hand-edited or upstream-corrupted
    // state.json with NaN/Infinity here would silently pass and the
    // loop driver would compare NaN < limits forever. Reject finite-
    // numeric fields explicitly.
    if (t === "number" && !Number.isFinite(r[k] as number)) {
      throw new StateError(
        `state.json: field \`${k}\` must be a finite number, got ${r[k]}`,
      );
    }
  }
  const VALID_STATES: ReadonlySet<string> = new Set([
    "running", "paused", "escalated", "guardrail_trip", "done",
  ]);
  if (!VALID_STATES.has(r.state as string)) {
    throw new StateError(
      `state.json: \`state\` must be one of ${[...VALID_STATES].join("|")}, got "${r.state}"`,
    );
  }
  // Cross-field invariants — when `state` claims a non-running mode,
  // the matching info object must be populated. Catches a hand-edited
  // state.json that would otherwise silently advance.
  const requiredCompanion: Record<string, string> = {
    paused: "pause",
    escalated: "escalation",
    guardrail_trip: "guardrail_trip",
  };
  const companion = requiredCompanion[r.state as string];
  if (companion && (r[companion] === null || r[companion] === undefined)) {
    throw new StateError(`state.json: state=${r.state} but \`${companion}\` is null`);
  }
  if (r.last_failure === undefined) r.last_failure = null;
  if (r.cache_low_streak === undefined) r.cache_low_streak = 0;
  if (r.steps_since_session_reset === undefined) r.steps_since_session_reset = 0;
  if (r.worktree === undefined) r.worktree = null;
  return r as unknown as CcloopState;
}

export async function writeState(path: string, state: CcloopState): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(state, null, 2));
}
