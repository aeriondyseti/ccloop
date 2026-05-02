/**
 * Lifecycle event emission for the design loop.
 *
 * Emits events to ./.ccloop/events.jsonl (same file the build loop uses).
 * This allows operators to track design sessions alongside build runs.
 */

import { join } from "node:path";
import { EventLogger } from "../state/events.ts";
import { nowIso, type IsoTimestamp } from "../branded.ts";
import type { DesignPhase, DesignEvent } from "./types.ts";

/**
 * Design event emitter.
 *
 * Wraps the build loop's EventLogger to emit design-specific events.
 * All events are written to ./.ccloop/events.jsonl.
 */
export class DesignEventEmitter {
  private readonly logger: EventLogger;

  constructor(cwd: string) {
    const eventsPath = join(cwd, ".ccloop", "events.jsonl");
    this.logger = new EventLogger(eventsPath);
  }

  /**
   * Emit a design session start event.
   */
  async sessionStart(phase: DesignPhase): Promise<void> {
    await this.logger.append({
      type: "design_session_start" as any,
      phase,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit a phase transition event.
   */
  async phaseEnter(phase: DesignPhase): Promise<void> {
    await this.logger.append({
      type: "design_phase_enter" as any,
      phase,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit an ask_user invocation event.
   */
  async askUserAsked(question: string): Promise<void> {
    await this.logger.append({
      type: "ask_user_asked" as any,
      question,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit an ask_user response event.
   */
  async askUserAnswered(selected: string[], freeform?: string): Promise<void> {
    await this.logger.append({
      type: "ask_user_answered" as any,
      selected,
      freeform,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit a draft file edit event.
   */
  async draftEdit(filePath: string): Promise<void> {
    await this.logger.append({
      type: "draft_edit" as any,
      file_path: filePath,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit a session acceptance event.
   */
  async sessionAccept(turnCount: number, totalCostUsd: number): Promise<void> {
    await this.logger.append({
      type: "design_session_accept" as any,
      turn_count: turnCount,
      total_cost_usd: totalCostUsd,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit a session abort event.
   */
  async sessionAbort(reason: string): Promise<void> {
    await this.logger.append({
      type: "design_session_abort" as any,
      reason,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit a session end event.
   */
  async sessionEnd(outcome: "accepted" | "aborted" | "error"): Promise<void> {
    await this.logger.append({
      type: "design_session_end" as any,
      outcome,
      step: 0,
      run_id: "" as any,
    });
  }

  /**
   * Emit a raw design event.
   *
   * For custom events or direct control over event structure.
   */
  async emit(event: DesignEvent): Promise<void> {
    const { timestamp, ...rest } = event;
    await this.logger.append({
      ...rest,
      type: event.type as any,
      step: 0,
      run_id: "" as any,
      ts: timestamp as IsoTimestamp,
    });
  }
}

/**
 * Create a design event emitter for a given project directory.
 *
 * @param cwd - Current working directory
 * @returns Event emitter instance
 */
export function createDesignEventEmitter(cwd: string): DesignEventEmitter {
  return new DesignEventEmitter(cwd);
}
