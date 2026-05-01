/**
 * Liveness ping (§9.7 sibling): POST to a configured URL after every
 * step so an off-device monitor can alert when ccloop goes silent
 * overnight. Designed for healthchecks.io-style endpoints — they
 * ignore the body, but we send a small JSON envelope anyway so
 * richer consumers can render context.
 *
 * Best-effort: any error (timeout, non-2xx, network) returns the
 * failure but never throws. Not rate-limited locally — the whole
 * point is "ccloop is alive every N minutes." If the user picks an
 * over-eager cadence vs. their endpoint's tolerance, the endpoint
 * will reject the extras; ccloop doesn't second-guess.
 */

export interface HeartbeatBody {
  run_id: string;
  step: number;
  outcome: string;
  state: string;
  ts: string;
}

export interface HeartbeatOptions {
  url: string;
  body: HeartbeatBody;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
}

export interface HeartbeatResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function pingHeartbeat(opts: HeartbeatOptions): Promise<HeartbeatResult> {
  if (!opts.url) return { ok: false, status: null, error: "no url" };
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await f(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const e = err as Error;
    const error = e.name === "TimeoutError" || e.name === "AbortError"
      ? `timeout after ${timeoutMs}ms`
      : e.message;
    return { ok: false, status: null, error };
  }
}
