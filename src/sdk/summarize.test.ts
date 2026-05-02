import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SUMMARIZE_PROMPT, summarizeSession } from "./summarize.ts";
import { asSessionId } from "../branded.ts";
import {
  fakeAssistantText, fakeResultMessage,
} from "./sdkMessages.fixtures.ts";

let capturedPrompt = "";
let capturedOptions: Record<string, unknown> = {};

function makeQuery(messages: SDKMessage[]): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((args: { prompt: string; options: unknown }) => {
    capturedPrompt = args.prompt;
    capturedOptions = args.options as Record<string, unknown>;
    async function* gen() { for (const m of messages) yield m; }
    return gen() as never;
  }) as never;
}

describe("summarizeSession", () => {
  test("uses the SUMMARIZE_PROMPT and resumes the given session", async () => {
    const queryImpl = makeQuery([fakeAssistantText("done"), fakeResultMessage({ result: "done" })]);
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
      fakeAssistantText("part one\n"),
      fakeAssistantText("part two"),
      fakeResultMessage(),
    ]);
    const out = await summarizeSession({
      cwd: "/tmp", resumeSessionId: asSessionId("s"), queryImpl,
    });
    expect(out).toContain("part one");
    expect(out).toContain("part two");
  });

  test("clamps to maxChars and appends a marker", async () => {
    const big = "x".repeat(5000);
    const queryImpl = makeQuery([fakeAssistantText(big), fakeResultMessage()]);
    const out = await summarizeSession({
      cwd: "/tmp", resumeSessionId: asSessionId("s"),
      queryImpl, maxChars: 100,
    });
    expect(out.length).toBeLessThanOrEqual(130);
    expect(out).toContain("(summary truncated)");
  });

  test("returns empty string when timeoutMs elapses (no model output)", async () => {
    // Iterator yields nothing and never returns; we rely on the
    // timeout's AbortController to break us out. Bun's await-for-of
    // on the abort signal raises an AbortError which the caller
    // swallows.
    const queryImpl = ((args: { options: { abortController?: AbortController } }) => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        await new Promise<void>((resolve) => {
          args.options.abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // Never yield anything; once aborted, just exit.
      }
      return gen() as never;
    }) as never;
    const start = Date.now();
    const out = await summarizeSession({
      cwd: "/tmp", resumeSessionId: asSessionId("s"),
      queryImpl, timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(out).toBe("");
    // Confirm we exited via the timeout, not by waiting forever.
    expect(elapsed).toBeLessThan(1000);
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
