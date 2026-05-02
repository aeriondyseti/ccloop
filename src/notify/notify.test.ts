import { describe, expect, test } from "bun:test";
import { notify } from "./notify.ts";

describe("notify", () => {
  test("no urls → no requests", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await notify(
      { run_id: "r", step: 1, reason: "x", trail: [], summary: "s" },
      { pushUrl: "", webhookUrl: "", fetchImpl },
    );
    expect(calls).toBe(0);
    expect(r).toEqual([]);
  });

  test("push posts text/plain", async () => {
    let captured: { url?: string; type?: string; body?: string } = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = {
        url, type: (init?.headers as Record<string, string>)["content-type"],
        body: init?.body as string,
      };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await notify(
      { run_id: "r", step: 1, reason: "x", trail: [], summary: "hi" },
      { pushUrl: "https://example.com/p", webhookUrl: "", fetchImpl },
    );
    expect(captured.url).toBe("https://example.com/p");
    expect(captured.type).toBe("text/plain");
    expect(captured.body).toBe("hi");
  });

  test("webhook posts JSON envelope", async () => {
    let body: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const r = await notify(
      { run_id: "r1", step: 7, reason: "weekly", trail: [{ a: 1 }], summary: "s" },
      { pushUrl: "", webhookUrl: "https://hook", fetchImpl },
    );
    expect(r[0]?.channel).toBe("webhook");
    expect(JSON.parse(body!).run_id).toBe("r1");
  });

  test("network failure is captured", async () => {
    const fetchImpl = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const r = await notify(
      { run_id: "r", step: 1, reason: "x", trail: [], summary: "s" },
      { pushUrl: "https://example.com", webhookUrl: "", fetchImpl },
    );
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.error).toBe("boom");
  });

  test("lazy trail builder is skipped when no webhook URL set", async () => {
    let trailCalls = 0;
    const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    await notify(
      {
        run_id: "r", step: 1, reason: "x", summary: "s",
        trail: async () => { trailCalls++; return [{ tag: "should-not-run" }]; },
      },
      { pushUrl: "https://push.example", webhookUrl: "", fetchImpl },
    );
    expect(trailCalls).toBe(0);
  });

  test("lazy trail builder runs once when webhook fires", async () => {
    let trailCalls = 0;
    let body = "";
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await notify(
      {
        run_id: "r", step: 1, reason: "x", summary: "s",
        trail: async () => { trailCalls++; return [{ tag: "ran" }]; },
      },
      { pushUrl: "", webhookUrl: "https://hook.example", fetchImpl },
    );
    expect(trailCalls).toBe(1);
    expect(JSON.parse(body).trail[0].tag).toBe("ran");
  });

  test("local rate-limit suppression carries rateLimited: true", async () => {
    // Distinguishes "we throttled ourselves" from "the channel is
    // broken" so downstream consumers (events.jsonl, recap) don't
    // conflate the two.
    const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const rl = { lastPushMs: 0, lastWebhookMs: 0 };
    let now = 1000;
    // First call: succeeds.
    const r1 = await notify(
      { run_id: "r", step: 1, reason: "x", trail: [], summary: "s" },
      { pushUrl: "https://p", webhookUrl: "", fetchImpl },
      rl,
      () => now,
    );
    expect(r1[0]?.ok).toBe(true);
    expect(r1[0]?.rateLimited).toBeUndefined();
    // Second call within the 60s window: rate-limited.
    now += 1000;
    const r2 = await notify(
      { run_id: "r", step: 2, reason: "x", trail: [], summary: "s" },
      { pushUrl: "https://p", webhookUrl: "", fetchImpl },
      rl,
      () => now,
    );
    expect(r2[0]?.ok).toBe(false);
    expect(r2[0]?.rateLimited).toBe(true);
  });

  test("push and webhook fire in parallel, not serial", async () => {
    // Each fetch sleeps 100ms before resolving. Serial would be
    // ~200ms; parallel ~100ms. Generous bound (300ms) tolerates
    // CI jitter while still catching a regression to serial.
    const fetchImpl = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const start = Date.now();
    const r = await notify(
      { run_id: "r", step: 1, reason: "x", trail: [], summary: "s" },
      { pushUrl: "https://p.example", webhookUrl: "https://h.example", fetchImpl },
    );
    const elapsed = Date.now() - start;
    expect(r.length).toBe(2);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(elapsed).toBeLessThan(300);
  });

  test("hung host is bounded by timeoutMs", async () => {
    // Fetch resolves only when its caller's signal aborts. Without a
    // timeout, this would hang the orchestrator overnight.
    const fetchImpl = ((url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (!sig) return; // Test fails by hanging — acceptable signal.
        sig.addEventListener("abort", () => {
          const err = new Error(`aborted ${url}`);
          err.name = "TimeoutError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const start = Date.now();
    const r = await notify(
      { run_id: "r", step: 1, reason: "x", trail: [], summary: "s" },
      { pushUrl: "https://hung.example", webhookUrl: "", fetchImpl, timeoutMs: 50 },
    );
    const elapsed = Date.now() - start;
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.error).toContain("timeout after 50ms");
    expect(elapsed).toBeLessThan(500);
  });
});
