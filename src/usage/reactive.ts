/**
 * Reactive rate-limit error parsing per §8.4. Pure string heuristics
 * over an SDK error message; output drives the same PAUSED / ESCALATED
 * decision as proactive detection.
 */

import { type IsoTimestamp, isoFromMs } from "../branded.ts";

export type ReactiveDecision =
  | { kind: "pause"; until: IsoTimestamp }
  | { kind: "escalate"; reason: string };

export interface ReactiveOptions {
  /** Default pause when no reset is parseable (§8.4). */
  defaultPauseSeconds: number;
  /** §8.4 tiebreaker — resets > this many ms in the future are weekly. */
  weeklyHorizonMs?: number;
  now?: () => number;
}

const WEEKLY_HORIZON_DEFAULT_MS = 12 * 60 * 60 * 1000;

const WEEKLY_RE = /weekly|seven[\s-]?day|7[\s-]?day/i;
const SESSION_RE = /\b5h\b|five[\s-]?hour|session limit/i;

const RATE_LIMIT_INDICATOR_RE = /rate[\s-]?limit|five[\s-]?hour|seven[\s-]?day|weekly|5h|429|too many requests/i;

export function isRateLimitError(text: string): boolean {
  return RATE_LIMIT_INDICATOR_RE.test(text);
}

// Captures: ISO 8601 reset-at fragments, or "(reset|resets) at ..." or
// "in N (minutes|hours)".
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;
const RELATIVE_RE = /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\b/i;

export function parseRateLimitError(
  text: string,
  opts: ReactiveOptions,
): ReactiveDecision {
  const horizon = opts.weeklyHorizonMs ?? WEEKLY_HORIZON_DEFAULT_MS;
  const now = (opts.now ?? Date.now)();
  const resetMs = parseReset(text, now);

  const isWeekly = WEEKLY_RE.test(text);
  const isSession = SESSION_RE.test(text);

  if (isWeekly && !isSession) {
    return { kind: "escalate", reason: "weekly_cap (reactive)" };
  }
  if (isSession && !isWeekly) {
    const until = resetMs ?? now + opts.defaultPauseSeconds * 1000;
    return { kind: "pause", until: isoFromMs(until) };
  }

  // Ambiguous. Use horizon tiebreaker.
  if (resetMs !== null) {
    if (resetMs - now > horizon) {
      return { kind: "escalate", reason: "weekly_cap (reactive, > 12h)" };
    }
    return { kind: "pause", until: isoFromMs(resetMs) };
  }
  return {
    kind: "pause",
    until: isoFromMs(now + opts.defaultPauseSeconds * 1000),
  };
}

function parseReset(text: string, now: number): number | null {
  const iso = ISO_RE.exec(text);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (Number.isFinite(t)) return t;
  }
  const rel = RELATIVE_RE.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (Number.isFinite(n)) {
      const ms = unitToMs(n, unit);
      if (ms !== null) return now + ms;
    }
  }
  return null;
}

function unitToMs(n: number, unit: string): number | null {
  if (unit.startsWith("s")) return n * 1000;
  if (unit.startsWith("m")) return n * 60 * 1000;
  if (unit.startsWith("h")) return n * 60 * 60 * 1000;
  return null;
}
