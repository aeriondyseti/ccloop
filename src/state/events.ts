import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type IsoTimestamp, type RunId, nowIso } from "../branded.ts";
import { isENOENT } from "../errors.ts";

export type EventType =
  | "instance_start"
  | "instance_exit"
  | "step_start"
  | "step_end"
  | "step_failed"
  | "pause_enter"
  | "pause_exit"
  | "operator_pause_enter"
  | "operator_pause_exit"
  | "escalate"
  | "escalation_resolved"
  | "guardrail_trip"
  | "notification_sent"
  | "usage_degraded"
  | "cache_warning"
  | "recovery_commit"
  | "session_rotated"
  | "worktree_finalized"
  | "done"
  /** Bus-only: live SDK stream events for the TUI. Not written to
   *  events.jsonl (would bloat the durable log). */
  | "stream_chunk"
  /** Bus-only: per-inference peak-context update. Lets the TUI
   *  advance its context bar every turn instead of only at
   *  step_end. */
  | "usage_tick"
  /** Bus-only: cadence-sleep boundaries. Lets the TUI render an
   *  "X/Y s until next step" countdown without polling. */
  | "cadence_wait_enter"
  | "cadence_wait_exit"
  /** Design-loop lifecycle events. Same JSONL file as the build-loop
   *  events; `run_id` is empty for design sessions because they don't
   *  carry one. */
  | "design_session_start"
  | "ask_user_asked"
  | "ask_user_answered"
  | "draft_edit"
  | "design_session_accept"
  | "design_session_abort"
  | "design_session_end";

export interface EventBase {
  ts: IsoTimestamp;
  /** Build-loop run id. Empty string on design-loop events — design
   *  sessions don't carry a run id. */
  run_id: RunId | "";
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

/** Load the last `limit` events from `events.jsonl`. Used at instance
 *  startup so the dashboard log pane shows recent activity from the
 *  prior session on `--continue`, not a blank pane until the next step
 *  fires. Malformed lines are skipped. Missing file → empty array.
 *
 *  Tails the file by reading a fixed-size suffix and growing the
 *  window if it didn't catch enough complete lines. Avoids loading
 *  multi-MB logs into memory on a long-running resume. */
export async function loadRecentEvents(
  path: string,
  limit: number,
): Promise<EventBase[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  if (size === 0 || limit <= 0) return [];

  // Average ccloop event JSON line is well under 1 KB. Start with a
  // generous tail window; double if it didn't yield enough complete
  // lines, capped at the whole file.
  const fh = await open(path, "r");
  try {
    let window = Math.min(size, Math.max(64 * 1024, limit * 1024));
    while (true) {
      const buf = Buffer.alloc(window);
      await fh.read(buf, 0, window, size - window);
      // Drop the partial first line if we didn't hit BOF — a window
      // that starts mid-line would parse to garbage.
      const startedAtBof = window >= size;
      const tail = buf.toString("utf8");
      const lines = startedAtBof ? tail.split("\n") : tail.split("\n").slice(1);

      const out: EventBase[] = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
            out.push(parsed as EventBase);
          }
        } catch {
          // skip malformed
        }
      }
      if (out.length >= limit || startedAtBof) {
        return out.slice(-limit);
      }
      // Not enough complete lines; widen and retry.
      window = Math.min(size, window * 2);
    }
  } finally {
    await fh.close();
  }
}
