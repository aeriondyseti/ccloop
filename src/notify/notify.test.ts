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
});
