/**
 * §10 — pure pre-flight guardrail evaluation. State machine outside.
 */
import type { LoopConfig } from "../config/schema.ts";
import { parseWallClock } from "./duration.ts";

export type GuardrailDecision =
  | { trip: false }
  | { trip: true; which: "max_steps" | "max_wall_clock"; limit: number; actual: number };

export interface GuardrailContext {
  currentStep: number;       // *next* step about to run (1-based)
  wallClockMs: number;       // accumulated across instances
}

export function checkGuardrails(
  cfg: LoopConfig,
  ctx: GuardrailContext,
): GuardrailDecision {
  if (cfg.max_steps > 0 && ctx.currentStep > cfg.max_steps) {
    return {
      trip: true,
      which: "max_steps",
      limit: cfg.max_steps,
      actual: ctx.currentStep,
    };
  }
  const wallMs = parseWallClock(cfg.max_wall_clock);
  if (wallMs !== null && ctx.wallClockMs >= wallMs) {
    return {
      trip: true,
      which: "max_wall_clock",
      limit: wallMs,
      actual: ctx.wallClockMs,
    };
  }
  return { trip: false };
}
