import { describe, expect, test } from "bun:test";
import { pingHeartbeat } from "./heartbeat.ts";

const baseBody = {
  run_id: "r",
  step: 1,
  outcome: "success",
  state: "running",
  ts: "2026-01-01T00:00:00.000Z",
};

describe("pingHeartbeat", () => {
  test("empty url → ok=false, no fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pingHeartbeat({ url: "", body: baseBody, fetchImpl });
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });

  test("posts JSON envelope to url", async () => {
    let captured: { url?: string; body?: string; type?: string } = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = {
        url,
        body: init?.body as string,
        type: (init?.headers as Record<string, string>)["content-type"],
      };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pingHeartbeat({
      url: "https://hc.example/abc",
      body: baseBody,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(captured.url).toBe("https://hc.example/abc");
    expect(captured.type).toBe("application/json");
    expect(JSON.parse(captured.body!).run_id).toBe("r");
  });

  test("non-2xx → ok=false with status", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const r = await pingHeartbeat({
      url: "https://hc.example",
      body: baseBody,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  test("network error is captured", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const r = await pingHeartbeat({
      url: "https://hc.example",
      body: baseBody,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });

  test("hung host bounded by timeoutMs", async () => {
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        sig.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const start = Date.now();
    const r = await pingHeartbeat({
      url: "https://hung.example",
      body: baseBody,
      fetchImpl,
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timeout after 50ms");
    expect(elapsed).toBeLessThan(500);
  });
});
