import { describe, expect, test } from "bun:test";
import { UsageClient, parseUsageBody } from "./client.ts";

describe("parseUsageBody", () => {
  test("parses well-formed body", () => {
    const snap = parseUsageBody({
      five_hour: { utilization: 42.0, resets_at: "2026-04-27T14:00:00Z" },
      seven_day: { utilization: 12.5, resets_at: "2026-05-01T00:00:00Z" },
    }, 1234);
    expect(snap?.five_hour.utilization).toBe(42);
    expect(snap?.fetched_at).toBe(1234);
  });

  test("rejects missing fields", () => {
    expect(parseUsageBody({ five_hour: {} }, 0)).toBe(null);
  });

  test("rejects non-numeric utilization", () => {
    expect(parseUsageBody({
      five_hour: { utilization: "x", resets_at: "2026-04-27T14:00:00Z" },
      seven_day: { utilization: 0, resets_at: "2026-04-27T14:00:00Z" },
    }, 0)).toBe(null);
  });

  test("ignores unknown extra keys", () => {
    const snap = parseUsageBody({
      five_hour: { utilization: 1, resets_at: "2026-04-27T14:00:00Z", extra: "foo" },
      seven_day: { utilization: 1, resets_at: "2026-04-27T14:00:00Z" },
      extra_usage: { foo: "bar" },
    }, 0);
    expect(snap).not.toBe(null);
  });
});

describe("UsageClient.get", () => {
  function mkClient(opts: { fetchImpl: typeof fetch; now: () => number; ttlMs?: number; timeoutMs?: number }) {
    return new UsageClient({
      token: "t",
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      ttlMs: opts.ttlMs,
      timeoutMs: opts.timeoutMs,
    });
  }

  test("happy path", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: "2026-04-27T14:00:00Z" },
        seven_day: { utilization: 5, resets_at: "2026-05-01T00:00:00Z" },
      }), { status: 200 })) as unknown as typeof fetch;
    const c = mkClient({ fetchImpl, now: () => 0 });
    const r = await c.get();
    expect(r.kind).toBe("ok");
  });

  test("rate_limited returns lastGood", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2026-04-27T14:00:00Z" },
          seven_day: { utilization: 5, resets_at: "2026-05-01T00:00:00Z" },
        }), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    let now = 0;
    const c = mkClient({ fetchImpl, now: () => now, ttlMs: 100 });
    await c.get();
    now = 200;
    const r = await c.get();
    expect(r.kind).toBe("rate_limited");
    if (r.kind === "rate_limited") expect(r.lastGood).not.toBe(null);
  });

  test("auth_error reported on 401", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const c = mkClient({ fetchImpl, now: () => 0 });
    const r = await c.get();
    expect(r.kind).toBe("auth_error");
  });

  test("403 maps to endpoint_unavailable, not auth_error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const c = mkClient({ fetchImpl, now: () => 0 });
    const r = await c.get();
    expect(r.kind).toBe("endpoint_unavailable");
    if (r.kind === "endpoint_unavailable") {
      expect(r.status).toBe(403);
      expect(r.lastGood).toBe(null);
    }
  });

  test("endpoint_unavailable returns lastGood when cache exists", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2026-04-27T14:00:00Z" },
          seven_day: { utilization: 5, resets_at: "2026-05-01T00:00:00Z" },
        }), { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    let now = 0;
    const c = mkClient({ fetchImpl, now: () => now, ttlMs: 100 });
    await c.get();
    now = 200;
    const r = await c.get();
    expect(r.kind).toBe("endpoint_unavailable");
    if (r.kind === "endpoint_unavailable") expect(r.lastGood).not.toBe(null);
  });

  test("shape_mismatch reported", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ unknown: 1 }), { status: 200 })) as unknown as typeof fetch;
    const c = mkClient({ fetchImpl, now: () => 0 });
    const r = await c.get();
    expect(r.kind).toBe("shape_mismatch");
  });

  test("hung endpoint is bounded by timeoutMs", async () => {
    // fetch resolves only when its caller's signal aborts.
    const fetchImpl = ((url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        sig.addEventListener("abort", () => {
          const err = new Error(`aborted ${url}`);
          err.name = "TimeoutError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const start = Date.now();
    const c = mkClient({ fetchImpl, now: () => 0, timeoutMs: 50 });
    const r = await c.get();
    const elapsed = Date.now() - start;
    expect(r.kind).toBe("network_error");
    if (r.kind === "network_error") {
      expect(r.error).toContain("timeout after 50ms");
    }
    expect(elapsed).toBeLessThan(500);
  });

  test("cache hit avoids second fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: "2026-04-27T14:00:00Z" },
        seven_day: { utilization: 5, resets_at: "2026-05-01T00:00:00Z" },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = mkClient({ fetchImpl, now: () => 0, ttlMs: 999_999 });
    await c.get();
    await c.get();
    expect(calls).toBe(1);
  });
});
