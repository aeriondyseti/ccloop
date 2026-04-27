import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type IsoTimestamp, type RunId, type SessionId,
  isoFromDate, newRunId,
} from "../branded.ts";
import { isENOENT } from "../errors.ts";

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

export interface CcloopState {
  schema_version: number;
  run_id: RunId;
  started_at: IsoTimestamp;
  current_step: number;
  wall_clock_ms: number;
  session_id: SessionId | null;
  consecutive_failures: number;
  no_progress_count: number;
  diff_hashes_recent: string[];
  state: RunStateName;
  pause: PauseInfo | null;
  escalation: EscalationInfo | null;
  guardrail_trip: GuardrailTripInfo | null;
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
    diff_hashes_recent: [],
    state: "running",
    pause: null,
    escalation: null,
    guardrail_trip: null,
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
  }
  return r as unknown as CcloopState;
}

const ensuredDirs = new Set<string>();

export async function writeState(path: string, state: CcloopState): Promise<void> {
  const dir = dirname(path);
  if (!ensuredDirs.has(dir)) {
    await mkdir(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  const tmp = `${path}.tmp.${process.pid}`;
  const body = JSON.stringify(state, null, 2);
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}
