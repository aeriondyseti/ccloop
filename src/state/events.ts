import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type IsoTimestamp, type RunId, nowIso } from "../branded.ts";

export type EventType =
  | "instance_start"
  | "instance_exit"
  | "validation_ok"
  | "validation_failed"
  | "step_start"
  | "step_end"
  | "step_failed"
  | "tool_call"
  | "pause_enter"
  | "pause_exit"
  | "escalate"
  | "guardrail_trip"
  | "notification_sent"
  | "compact_boundary"
  | "done";

export interface EventBase {
  ts: IsoTimestamp;
  run_id: RunId;
  step: number;
  type: EventType;
  [k: string]: unknown;
}

export class EventLogger {
  private ensured = false;

  constructor(private readonly path: string) {}

  async append(event: Omit<EventBase, "ts"> & { ts?: IsoTimestamp }): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.ensured = true;
    }
    const withTs = {
      ...event,
      ts: event.ts ?? nowIso(),
    } as EventBase;
    await appendFile(this.path, JSON.stringify(withTs) + "\n", "utf8");
  }
}
