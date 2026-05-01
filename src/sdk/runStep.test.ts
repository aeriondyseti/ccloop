import { describe, expect, test } from "bun:test";
import { effortToThinkingTokens, runStep } from "./runStep.ts";
import { DEFAULTS, type CcloopConfig } from "../config/schema.ts";

type SdkMsg = Record<string, unknown>;
type FakeQueryArgs = { prompt: string | unknown; options: Record<string, unknown> };

/** Build a queryImpl that yields a scripted sequence of SDK message
 *  arrays. Each `call` script is one SDK invocation's worth of
 *  messages; subsequent calls (continuations) consume the next
 *  scripted call. */
function fakeQuery(scripts: SdkMsg[][]) {
  let i = 0;
  const calls: FakeQueryArgs[] = [];
  const impl = (args: FakeQueryArgs) => {
    calls.push(args);
    const script = scripts[Math.min(i, scripts.length - 1)] ?? [];
    i++;
    async function* gen() {
      for (const m of script) yield m;
    }
    return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
  };
  return { impl: impl as unknown as Parameters<typeof runStep>[0]["queryImpl"], calls };
}

function mkResultMsg(p: { stopReason: string; sessionId: string; numTurns?: number; result?: string; usage?: Record<string, number> }): SdkMsg {
  return {
    type: "result",
    session_id: p.sessionId,
    subtype: "success",
    num_turns: p.numTurns ?? 1,
    total_cost_usd: 0.01,
    result: p.result ?? "ok",
    usage: p.usage ?? {},
  };
}

function mkAssistantMsg(stopReason: string, sessionId: string): SdkMsg {
  return {
    type: "assistant",
    session_id: sessionId,
    message: {
      stop_reason: stopReason,
      content: [{ type: "text", text: `progress (${stopReason})` }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

function baseInput(cfg: CcloopConfig, queryImpl: Parameters<typeof runStep>[0]["queryImpl"]) {
  return {
    prompt: "do step 1",
    cwd: "/tmp",
    config: cfg,
    resumeSessionId: null,
    queryImpl,
  } as Parameters<typeof runStep>[0];
}

describe("runStep pause_turn continuations", () => {
  test("non-pause_turn end → exactly one SDK call", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.claude.max_continuations_per_step = 5;
    const fq = fakeQuery([[
      mkAssistantMsg("end_turn", "s1"),
      mkResultMsg({ stopReason: "end_turn", sessionId: "s1" }),
    ]]);
    const r = await runStep(baseInput(cfg, fq.impl));
    expect(fq.calls.length).toBe(1);
    expect(r.stop_reason).toBe("end_turn");
    expect(r.session_id).toBe("s1" as unknown as typeof r.session_id);
  });

  test("pause_turn loops with same session, capped by max_continuations", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.claude.max_continuations_per_step = 2;
    // 3 calls would be needed to reach end_turn, but cap is 2, so the
    // 2nd continuation is the last attempt. Setup: pause, pause, pause.
    const fq = fakeQuery([
      [mkAssistantMsg("pause_turn", "s1"), mkResultMsg({ stopReason: "pause_turn", sessionId: "s1" })],
      [mkAssistantMsg("pause_turn", "s1"), mkResultMsg({ stopReason: "pause_turn", sessionId: "s1" })],
      [mkAssistantMsg("pause_turn", "s1"), mkResultMsg({ stopReason: "pause_turn", sessionId: "s1" })],
    ]);
    const r = await runStep(baseInput(cfg, fq.impl));
    // 1 initial call + 2 continuations = 3 calls total.
    expect(fq.calls.length).toBe(3);
    expect(r.stop_reason).toBe("pause_turn");
    // The continuation calls used resume=s1 + prompt="continue".
    expect(fq.calls[1]?.options.resume).toBe("s1");
    expect(fq.calls[1]?.prompt).toBe("continue");
    expect(fq.calls[2]?.options.resume).toBe("s1");
  });

  test("continuation completes naturally and aggregates usage + turns", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.claude.max_continuations_per_step = 5;
    const fq = fakeQuery([
      [mkAssistantMsg("pause_turn", "s1"), mkResultMsg({ stopReason: "pause_turn", sessionId: "s1", numTurns: 50 })],
      [mkAssistantMsg("end_turn", "s1"), mkResultMsg({ stopReason: "end_turn", sessionId: "s1", numTurns: 12 })],
    ]);
    const r = await runStep(baseInput(cfg, fq.impl));
    expect(fq.calls.length).toBe(2);
    expect(r.stop_reason).toBe("end_turn");
    // numTurns sums across calls.
    expect(r.num_turns).toBe(62);
    // Usage aggregates: each assistant message added 100 in / 50 out.
    expect(r.usage.input_tokens).toBe(200);
    expect(r.usage.output_tokens).toBe(100);
  });

  test("aborted signal between continuations skips further SDK calls", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.claude.max_continuations_per_step = 5;
    const ac = new AbortController();
    const fq = fakeQuery([
      [mkAssistantMsg("pause_turn", "s1"), mkResultMsg({ stopReason: "pause_turn", sessionId: "s1" })],
      [mkAssistantMsg("end_turn", "s1"), mkResultMsg({ stopReason: "end_turn", sessionId: "s1" })],
    ]);
    const input = baseInput(cfg, fq.impl);
    input.abortController = ac;
    // Abort *after* the first call's iterator has fully drained but
    // before the loop has a chance to start a continuation.
    const original = fq.impl!;
    let nthCall = 0;
    input.queryImpl = ((args: Parameters<NonNullable<typeof input.queryImpl>>[0]) => {
      nthCall++;
      if (nthCall === 1) {
        // Simulate the SDK getting interrupted right at the
        // pause_turn boundary: drain the script, then fire abort.
        const wrapped = original(args);
        async function* drainThenAbort() {
          for await (const m of wrapped) yield m;
          ac.abort();
        }
        return drainThenAbort() as ReturnType<typeof original>;
      }
      return original(args);
    }) as typeof input.queryImpl;
    const r = await runStep(input);
    expect(fq.calls.length).toBe(1);
    expect(r.stop_reason).toBe("pause_turn");
  });

  test("max_continuations_per_step=0 disables the loop", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.claude.max_continuations_per_step = 0;
    const fq = fakeQuery([
      [mkAssistantMsg("pause_turn", "s1"), mkResultMsg({ stopReason: "pause_turn", sessionId: "s1" })],
      [mkAssistantMsg("end_turn", "s1"), mkResultMsg({ stopReason: "end_turn", sessionId: "s1" })],
    ]);
    const r = await runStep(baseInput(cfg, fq.impl));
    expect(fq.calls.length).toBe(1);
    expect(r.stop_reason).toBe("pause_turn");
  });
});

describe("effortToThinkingTokens", () => {
  test("low/medium/high/xhigh map to ascending budgets", () => {
    const low = effortToThinkingTokens("low")!;
    const med = effortToThinkingTokens("medium")!;
    const high = effortToThinkingTokens("high")!;
    const xhigh = effortToThinkingTokens("xhigh")!;
    expect(low).toBeGreaterThan(0);
    expect(med).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(med);
    expect(xhigh).toBeGreaterThan(high);
  });

  test("case-insensitive", () => {
    expect(effortToThinkingTokens("XHigh")).toBe(effortToThinkingTokens("xhigh"));
  });

  test("unrecognized → undefined (SDK default applies)", () => {
    expect(effortToThinkingTokens("ludicrous")).toBeUndefined();
    expect(effortToThinkingTokens("")).toBeUndefined();
  });
});
