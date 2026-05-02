/**
 * One-shot session summarization.
 *
 * Invoked by the driver right before it rotates an SDK session
 * (proactive threshold or step-count cap), so the next session
 * starts with the model's own running picture of "what was I just
 * working on?" rather than a blank slate. Replaces the hard-rotate
 * tech debt called out in TECH-DEBT.md.
 *
 * Not invoked on reactive context_overflow rotations: by the time
 * we see that signal the session is already wedged and any further
 * query against it would just hit the same wall. For that path the
 * caller passes `null` summary to the next step.
 */
import {
  query as defaultQuery,
  type SDKMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { type SessionId } from "../branded.ts";
import { extractAssistantText } from "./runStep.ts";

type QueryImpl = typeof defaultQuery;

export interface SummarizeSessionInput {
  cwd: string;
  resumeSessionId: SessionId;
  abortController?: AbortController;
  /** Test seam — defaults to the SDK's `query`. */
  queryImpl?: QueryImpl;
  /** Cap on the model's response in characters. Defaults to 4000 —
   *  long enough to carry decisions/state, short enough not to
   *  immediately re-bloat the next session's first turn. */
  maxChars?: number;
  /** SDK timeout. The summarize step is rare and the failure mode of
   *  a stuck call (overnight hang) is bad — keep it tight. */
  timeoutMs?: number;
}

export const SUMMARIZE_PROMPT =
  "Briefly summarize this session for a fresh agent that will pick up where you left off. " +
  "Cover (1) the goal you're working toward, (2) what's done and what's in-flight, " +
  "(3) any decisions or constraints the next agent must respect, (4) gotchas the next " +
  "agent might re-discover. Use plain prose, no headings, no bullet lists. " +
  "Do not call any tools. Reply with the summary directly. " +
  "Stay under 300 words — the next session will read this as context.";

/** Run a one-shot summarization query against an existing SDK session.
 *  Returns the model's text response, or empty string on timeout/error
 *  (the caller should treat empty summary as "no carry-over"). */
export async function summarizeSession(
  input: SummarizeSessionInput,
): Promise<string> {
  const queryImpl = input.queryImpl ?? defaultQuery;
  const maxChars = input.maxChars ?? 4000;
  const timeoutMs = input.timeoutMs ?? 60_000;

  // Local abort controller so the timeout doesn't leak into the
  // caller's controller — the parent run shouldn't be aborted just
  // because summarization stalled.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // Honor the caller's external cancel too.
  const onParentAbort = () => ac.abort();
  input.abortController?.signal.addEventListener("abort", onParentAbort);

  const opts: Options = {
    cwd: input.cwd,
    resume: input.resumeSessionId,
    maxTurns: 1,
    permissionMode: "default",
    abortController: ac,
    settingSources: ["project"],
  };

  const collected: string[] = [];
  try {
    for await (const msg of queryImpl({ prompt: SUMMARIZE_PROMPT, options: opts }) as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        const t = extractAssistantText(msg.message.content);
        if (t) collected.push(t);
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && typeof msg.result === "string" && msg.result.length > 0) {
          collected.push(msg.result);
        }
        break;
      }
    }
  } catch {
    // Best-effort. A failed summary is not worth aborting the rotation.
    return "";
  } finally {
    clearTimeout(timer);
    input.abortController?.signal.removeEventListener("abort", onParentAbort);
  }

  const text = collected.join("\n").trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…(summary truncated)";
}
