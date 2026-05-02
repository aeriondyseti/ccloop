/**
 * Lifecycle event emission for the design loop. Writes to the same
 * ./.ccloop/events.jsonl the build loop uses so an operator can tail
 * a single file across both phases.
 */

import { join } from "node:path";
import { EventLogger } from "../state/events.ts";
import type { IsoTimestamp } from "../branded.ts";
import type { DesignPhase, DesignEvent } from "./types.ts";

export class DesignEventEmitter {
  private readonly logger: EventLogger;

  constructor(cwd: string) {
    this.logger = new EventLogger(join(cwd, ".ccloop", "events.jsonl"));
  }

  async sessionStart(phase: DesignPhase): Promise<void> {
    await this.logger.append({
      type: "design_session_start", phase, step: 0, run_id: "",
    });
  }

  async phaseEnter(phase: DesignPhase): Promise<void> {
    await this.logger.append({
      type: "design_phase_enter", phase, step: 0, run_id: "",
    });
  }

  async askUserAsked(question: string): Promise<void> {
    await this.logger.append({
      type: "ask_user_asked", question, step: 0, run_id: "",
    });
  }

  async askUserAnswered(selected: string[], freeform?: string): Promise<void> {
    await this.logger.append({
      type: "ask_user_answered", selected, freeform, step: 0, run_id: "",
    });
  }

  async draftEdit(filePath: string): Promise<void> {
    await this.logger.append({
      type: "draft_edit", file_path: filePath, step: 0, run_id: "",
    });
  }

  async sessionAccept(turnCount: number, totalCostUsd: number): Promise<void> {
    await this.logger.append({
      type: "design_session_accept",
      turn_count: turnCount, total_cost_usd: totalCostUsd,
      step: 0, run_id: "",
    });
  }

  async sessionAbort(reason: string): Promise<void> {
    await this.logger.append({
      type: "design_session_abort", reason, step: 0, run_id: "",
    });
  }

  async sessionEnd(outcome: "accepted" | "aborted" | "error"): Promise<void> {
    await this.logger.append({
      type: "design_session_end", outcome, step: 0, run_id: "",
    });
  }

  /** Escape hatch for callers that already have a structured `DesignEvent`. */
  async emit(event: DesignEvent): Promise<void> {
    const { timestamp, ...rest } = event;
    await this.logger.append({
      ...rest,
      type: event.type,
      step: 0,
      run_id: "",
      ts: timestamp as IsoTimestamp,
    });
  }
}

export function createDesignEventEmitter(cwd: string): DesignEventEmitter {
  return new DesignEventEmitter(cwd);
}
