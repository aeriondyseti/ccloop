/**
 * Translate raw Agent SDK messages into the `TurnEvent` shape the TUI
 * consumes. Stateful only to pair `tool_result` blocks back to the
 * `tool_use` that named them.
 *
 * Pure with respect to time — the caller stamps `ts` so tests can pin
 * it.
 */
import type { TodoItem, TurnEvent } from "../tui/types.ts";
import { truncateToWidth } from "../util/width.ts";

export class StreamParser {
  private toolNames = new Map<string, string>();

  consume(msg: unknown, ts: string): TurnEvent[] {
    const events: TurnEvent[] = [];
    if (!msg || typeof msg !== "object") return events;
    const m = msg as Record<string, unknown>;

    if (m.type === "assistant") {
      const inner = (m.message as Record<string, unknown> | undefined) ?? {};
      const content = inner.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          for (const ev of blockToEvents(block, this.toolNames, ts)) {
            events.push(ev);
          }
        }
      }
    } else if (m.type === "user") {
      const inner = (m.message as Record<string, unknown> | undefined) ?? {};
      const content = inner.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const ev = userBlockToEvent(block, this.toolNames, ts);
          if (ev) events.push(ev);
        }
      }
    }
    return events;
  }
}

function blockToEvents(
  block: unknown,
  toolNames: Map<string, string>,
  ts: string,
): TurnEvent[] {
  if (!block || typeof block !== "object") return [];
  const b = block as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") {
    const text = b.text.trim();
    return text ? [{ kind: "assistant_text", text, ts }] : [];
  }
  // Extended thinking: the SDK delivers reasoning as a `thinking`
  // block within the assistant message. Surface it so the operator
  // can see *why* the model reached a decision — the exact signal
  // you want when a step is misbehaving. Redacted-thinking blocks
  // (encrypted) are skipped: there's nothing useful to show.
  if (b.type === "thinking" && typeof b.thinking === "string") {
    const text = b.thinking.trim();
    return text ? [{ kind: "thinking", text, ts }] : [];
  }
  if (b.type === "tool_use") {
    const id = String(b.id ?? "");
    const name = String(b.name ?? "tool");
    if (id) toolNames.set(id, name);
    const events: TurnEvent[] = [{
      kind: "tool_use",
      tool: name,
      summary: summarizeToolInput(name, b.input),
      ts,
    }];
    // TodoWrite carries the agent's working plan in its `input.todos`
    // array. Emit a structured `todo_state` event in addition to the
    // generic tool_use so the TUI can render the live list.
    //
    // `parseTodoList` returns `null` on shape mismatch (malformed
    // input) → no event, prior state preserved. An empty array is
    // distinct: it means the agent legitimately cleared its plan, so
    // we emit `todo_state` with `[]` and let the TUI wipe.
    if (name === "TodoWrite") {
      const todos = parseTodoList(b.input);
      if (todos !== null) events.push({ kind: "todo_state", todos, ts });
    }
    return events;
  }
  return [];
}

/** Extract a TodoItem[] from a TodoWrite tool_use's `input` blob.
 *  Returns null on shape mismatch so the parser can fall back to the
 *  generic tool_use event without crashing on a malformed block. */
export function parseTodoList(input: unknown): TodoItem[] | null {
  if (!input || typeof input !== "object") return null;
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return null;
  const out: TodoItem[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const content = typeof r.content === "string" ? r.content : "";
    const status = r.status;
    if (
      content === "" ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      continue;
    }
    const item: TodoItem = { content, status };
    if (typeof r.activeForm === "string") item.activeForm = r.activeForm;
    out.push(item);
  }
  return out;
}

function userBlockToEvent(
  block: unknown,
  toolNames: Map<string, string>,
  ts: string,
): TurnEvent | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b.type !== "tool_result") return null;
  const id = String(b.tool_use_id ?? "");
  const name = toolNames.get(id) ?? "tool";
  const ok = b.is_error !== true;
  return {
    kind: "tool_result",
    tool: name,
    ok,
    excerpt: excerptToolResult(b.content),
    ts,
  };
}

const EXCERPT_MAX = 200;
const SUMMARY_MAX = 100;

export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const oneLine = (s: string): string =>
    truncateToWidth(s.replace(/\s+/g, " ").trim(), SUMMARY_MAX);
  if (name === "Bash") return oneLine(unwrapSandboxedBash(String(i.command ?? "")));
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "Read" || name === "NotebookEdit") {
    return oneLine(String(i.file_path ?? i.notebook_path ?? ""));
  }
  if (name === "Glob") return oneLine(String(i.pattern ?? ""));
  if (name === "Grep") return oneLine(String(i.pattern ?? ""));
  if (name === "WebFetch" || name === "WebSearch") {
    return oneLine(String(i.url ?? i.query ?? ""));
  }
  return oneLine(JSON.stringify(i));
}

export function excerptToolResult(content: unknown): string {
  if (typeof content === "string") {
    return truncateToWidth(firstNonEmptyLine(content), EXCERPT_MAX);
  }
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object") {
        const cc = c as Record<string, unknown>;
        if (cc.type === "text" && typeof cc.text === "string") {
          return truncateToWidth(firstNonEmptyLine(cc.text), EXCERPT_MAX);
        }
      }
    }
  }
  return "";
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** Strip the bwrap / sandbox-exec wrapper that the approver prepends
 *  (§6.5) so the dashboard's "now" pane shows the user-recognisable
 *  command, not 100 chars of `--ro-bind / / --proc /proc ...`.
 *  Both wrappers terminate with `/bin/sh -c '<inner>'`; if we
 *  recognise that suffix shape, return the inner command. Otherwise
 *  return as-is — defensive against future wrapper-shape changes. */
export function unwrapSandboxedBash(command: string): string {
  if (!command.startsWith("bwrap ") && !command.startsWith("sandbox-exec ")) {
    return command;
  }
  const m = /\/bin\/sh\s+-c\s+'((?:[^']|'\\'')*)'\s*$/.exec(command);
  if (!m || !m[1]) return command;
  return m[1].replace(/'\\''/g, "'");
}
