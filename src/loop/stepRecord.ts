import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type RuntimePaths, stepRecordPath } from "../state/paths.ts";
import { type StepUsage, cacheHitRate } from "../sdk/types.ts";
import {
  type IsoTimestamp, type RunId, type SessionId, type Sha,
  isoFromDate,
} from "../branded.ts";

export type StepOutcome = "success" | "failure" | "no-op";

export interface StepRecord {
  step: number;
  run_id: RunId;
  started_at: IsoTimestamp;
  ended_at: IsoTimestamp;
  duration_ms: number;
  outcome: StepOutcome;
  subtype: string;
  stop_reason: string | null;
  session_id: SessionId;
  num_turns: number;
  usage: StepUsage;
  cost_usd: number;
  cache_hit_rate: number;
  commit_sha: Sha;
  commit_subject: string;
  failure: { category: string; excerpt: string } | null;
}

export async function writeStepRecord(
  paths: RuntimePaths,
  rec: StepRecord,
): Promise<string> {
  const path = stepRecordPath(paths, rec.step);
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify(rec, null, 2);
  await writeFile(path, body, "utf8");
  return path;
}

export function buildStepRecord(args: {
  step: number;
  runId: RunId;
  startedAt: Date;
  endedAt: Date;
  outcome: StepOutcome;
  subtype: string;
  stopReason: string | null;
  sessionId: SessionId;
  numTurns: number;
  usage: StepUsage;
  costUsd: number;
  commitSha: Sha;
  commitSubject: string;
  failure: { category: string; excerpt: string } | null;
}): StepRecord {
  return {
    step: args.step,
    run_id: args.runId,
    started_at: isoFromDate(args.startedAt),
    ended_at: isoFromDate(args.endedAt),
    duration_ms: args.endedAt.getTime() - args.startedAt.getTime(),
    outcome: args.outcome,
    subtype: args.subtype,
    stop_reason: args.stopReason,
    session_id: args.sessionId,
    num_turns: args.numTurns,
    usage: args.usage,
    cost_usd: args.costUsd,
    cache_hit_rate: cacheHitRate(args.usage),
    commit_sha: args.commitSha,
    commit_subject: args.commitSubject,
    failure: args.failure,
  };
}
