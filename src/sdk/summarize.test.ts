import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SUMMARIZE_PROMPT, summarizeSession } from "./summarize.ts";
import { asSessionId } from "../branded.ts";

function makeQuery(messages: SDKMessage[]): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((args: { prompt: string; options: unknown }) => {
    capturedPrompt = args.prompt;
    capturedOptions = args.options as Record<string, unknown>;
    async function* gen() { for (const m of messages) yield m; }
    return gen() as never;
  }) as never;
}

let capturedPrompt = "";
let capturedOptions: Record<string, unknown> = {};

function mkAssistant(text: string): SDKMessage {
  return {
    type: "assistant",
    session_id: "sess",
    parent_tool_use_id: null,
    uuid: "11111111-1111-1111-1111-111111111111",
    message: {
      id: "m", type: "message", role: "assistant", model: "fake",
      stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text }] as never,
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 0 },
      } as never,
    } as never,
  } as never as SDKMessage;
}

function mkResult(result = ""): SDKMessage {
  return {
    type: "result", subtype: "success", session_id: "sess",
    num_turns: 1, total_cost_usd: 0, duration_ms: 0, duration_api_ms: 0,
    is_error: false, result,
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    } as never,
    permission_denials: [],
    modelUsage: {} as never,
    uuid: "00000000-0000-0000-0000-000000000000",
  } as never as SDKMessage;
}

describe("summarizeSession", () => {
  test("uses the SUMMARIZE_PROMPT and resumes the given session", async () => {
    const queryImpl = makeQuery([mkAssistant("done"), mkResult("done")]);
    const out = await summarizeSession({
      cwd: "/tmp/x", resumeSessionId: asSessionId("abc"), queryImpl,
    });
    expect(capturedPrompt).toBe(SUMMARIZE_PROMPT);
    expect((capturedOptions as { resume?: string }).resume).toBe("abc");
    expect((capturedOptions as { maxTurns?: number }).maxTurns).toBe(1);
    expect(out).toContain("done");
  });

  test("returns assistant text concatenated when no result text is provided", async () => {
    const queryImpl = makeQuery([
      mkAssistant("part one\n"),
      mkAssistant("part two"),
      mkResult(""),
    ]);
    const out = await summarizeSession({
      cwd: "/tmp", resumeSessionId: asSessionId("s"), queryImpl,
    });
    expect(out).toContain("part one");
    expect(out).toContain("part two");
  });

  test("clamps to maxChars and appends a marker", async () => {
    const big = "x".repeat(5000);
    const queryImpl = makeQuery([mkAssistant(big), mkResult("")]);
    const out = await summarizeSession({
      cwd: "/tmp", resumeSessionId: asSessionId("s"),
      queryImpl, maxChars: 100,
    });
    expect(out.length).toBeLessThanOrEqual(130);
    expect(out).toContain("(summary truncated)");
  });

  test("returns empty string on iterator error (best-effort)", async () => {
    const queryImpl = (() => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        throw new Error("boom");
      }
      return gen() as never;
    }) as never;
    const out = await summarizeSession({
      cwd: "/tmp", resumeSessionId: asSessionId("s"), queryImpl,
    });
    expect(out).toBe("");
  });
});
