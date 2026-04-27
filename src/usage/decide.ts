/**
 * Pre-flight decision per §8.3 / §8.5.
 *
 * Pure function over thresholds + a (possibly stale) snapshot. The
 * loop driver feeds the result into the state machine.
 */
import type { UsageSnapshot } from "./client.ts";
import { type IsoTimestamp, isoFromDate } from "../branded.ts";

export type UsageDecision =
  | { action: "proceed" }
  | { action: "pause"; until: IsoTimestamp; reason: string; window: "five_hour" }
  | { action: "escalate"; reason: string };

export interface UsageThresholds {
  pauseAtUtilization: number;     // 0-100
  escalateAtUtilization: number;  // 0-100
  resetBufferMs: number;          // §8.3 buffer; default 30_000
}

export const DEFAULT_THRESHOLDS: UsageThresholds = {
  pauseAtUtilization: 95.0,
  escalateAtUtilization: 80.0,
  resetBufferMs: 30_000,
};

export function decideUsage(
  snapshot: UsageSnapshot,
  thresholds: UsageThresholds = DEFAULT_THRESHOLDS,
): UsageDecision {
  // §8.8 — seven_day wins if both above threshold.
  if (snapshot.seven_day.utilization >= thresholds.escalateAtUtilization) {
    return {
      action: "escalate",
      reason: `weekly cap at ${snapshot.seven_day.utilization.toFixed(1)}%`,
    };
  }
  if (snapshot.five_hour.utilization >= thresholds.pauseAtUtilization) {
    const resetMs = Date.parse(snapshot.five_hour.resets_at);
    const untilDate = Number.isFinite(resetMs)
      ? new Date(resetMs + thresholds.resetBufferMs)
      : new Date(Date.now() + 60 * 60 * 1000);
    return {
      action: "pause",
      until: isoFromDate(untilDate),
      reason: `five_hour cap at ${snapshot.five_hour.utilization.toFixed(1)}%`,
      window: "five_hour",
    };
  }
  return { action: "proceed" };
}
