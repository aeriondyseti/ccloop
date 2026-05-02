/** Shared SDK-message factories for tests that drive the design
 *  orchestrator, summarize, and shutdown paths with a scripted
 *  `query` impl. Centralized so the SDK shape only needs to be kept
 *  in sync in one place when @anthropic-ai/claude-agent-sdk evolves.
 *
 *  Excluded from the published npm tarball via package.json#files —
 *  fixtures are dev-only. */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const FAKE_SESSION_ID = "fake-session";
const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

const ZERO_USAGE = {
  input_tokens: 0, output_tokens: 0,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  server_tool_use: { web_search_requests: 0 },
} as never;

/** A `result` message that satisfies the SDKMessage shape with
 *  zeroed-out telemetry. The optional `result` text seeds the
 *  terminal "result" string the orchestrator records as final_text. */
export function fakeResultMessage(opts: { result?: string; sessionId?: string } = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: opts.sessionId ?? FAKE_SESSION_ID,
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    result: opts.result ?? "",
    usage: ZERO_USAGE,
    permission_denials: [],
    modelUsage: {} as never,
    uuid: FAKE_UUID,
  } as never as SDKMessage;
}

/** An `assistant` message carrying an arbitrary content array.
 *  Callers pass in the blocks they care about (text, tool_use, etc.). */
export function fakeAssistantMessage(
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "thinking"; thinking: string }
  >,
  opts: { sessionId?: string } = {},
): SDKMessage {
  return {
    type: "assistant",
    session_id: opts.sessionId ?? FAKE_SESSION_ID,
    parent_tool_use_id: null,
    uuid: "11111111-1111-1111-1111-111111111111",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "fake",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: content as never,
      usage: ZERO_USAGE,
    } as never,
  } as never as SDKMessage;
}

/** Convenience: an assistant message with a single text block. */
export function fakeAssistantText(text: string): SDKMessage {
  return fakeAssistantMessage([{ type: "text", text }]);
}

/** Convenience: build a fake `query` impl that yields one or more
 *  scripted messages, in order, per call. Each "step" is a thunk so
 *  callers can perform real file-write side effects between yields. */
export function makeScriptedQuery(
  steps: Array<() => SDKMessage[]>,
): typeof import("@anthropic-ai/claude-agent-sdk").query {
  let i = 0;
  return (() => {
    const idx = i < steps.length ? i : steps.length - 1;
    const messages = idx >= 0 && steps[idx] ? steps[idx]!() : [];
    i++;
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const m of messages) yield m;
    }
    return gen() as never;
  }) as never;
}

/** Convenience: a single-call quiet `query` impl that yields just an
 *  empty result. Useful for tests that only care about the
 *  orchestrator's between-turn behaviour. */
export function makeQuietQuery(): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return makeScriptedQuery([() => [fakeResultMessage()]]);
}
