import { describe, expect, test } from "bun:test";
import { freshRateLimitState, notify } from "./notify.ts";

const env = { run_id: "r", step: 1, reason: "x", trail: [], summary: "s" };

describe("notify rate limiter", () => {
  test("two calls within 60s suppress second", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const rl = freshRateLimitState();
    let now = 1_000_000;
    await notify(env, { pushUrl: "u", webhookUrl: "", fetchImpl }, rl, () => now);
    now = 1_030_000;
    const second = await notify(env, { pushUrl: "u", webhookUrl: "", fetchImpl }, rl, () => now);
    expect(calls).toBe(1);
    expect(second[0]?.ok).toBe(false);
    expect(second[0]?.error).toMatch(/rate-limited/);
  });

  test("after 60s a second call goes through", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const rl = freshRateLimitState();
    let now = 1_000_000;
    await notify(env, { pushUrl: "u", webhookUrl: "", fetchImpl }, rl, () => now);
    now = 1_060_001;
    await notify(env, { pushUrl: "u", webhookUrl: "", fetchImpl }, rl, () => now);
    expect(calls).toBe(2);
  });

  test("push and webhook tracked independently", async () => {
    let pushCalls = 0;
    let webhookCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (url === "p") pushCalls++; else webhookCalls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const rl = freshRateLimitState();
    await notify(env, { pushUrl: "p", webhookUrl: "w", fetchImpl }, rl, () => 1_000_000);
    await notify(env, { pushUrl: "p", webhookUrl: "w", fetchImpl }, rl, () => 1_030_000);
    expect(pushCalls).toBe(1);   // second push suppressed
    expect(webhookCalls).toBe(1); // second webhook suppressed
  });

  test("without rateLimit state, no suppression", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await notify(env, { pushUrl: "u", webhookUrl: "", fetchImpl });
    await notify(env, { pushUrl: "u", webhookUrl: "", fetchImpl });
    expect(calls).toBe(2);
  });
});
