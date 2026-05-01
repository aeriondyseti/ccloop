/**
 * §9.7 — push and webhook notifiers. Best-effort: logs and continues
 * on failure. Rate-limited to one per channel per minute (the loop
 * driver decides when to call us; we don't track time globally).
 */

export interface NotifyEnvelope {
  run_id: string;
  step: number;
  reason: string;
  /** Webhook-only context. Pass a builder function to defer the work
   *  to send-time — `notify` won't invoke it if no webhook URL is
   *  configured or the webhook channel is rate-limited, so building
   *  the trail (which costs N step-record reads) is skipped on the
   *  paths that wouldn't have used it. */
  trail: unknown[] | (() => Promise<unknown[]>);
  /** Free-form short summary for push body. */
  summary: string;
}

export interface NotifyResult {
  channel: "push" | "webhook";
  ok: boolean;
  status: number | null;
  error?: string;
  /** True when this result represents a local rate-limit suppression
   *  (1/min/channel), not an actual network attempt. Distinguishes
   *  "the channel is broken" from "we throttled ourselves" for
   *  downstream consumers (events.jsonl, recap). */
  rateLimited?: boolean;
}

export interface NotifyOptions {
  pushUrl: string;
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10s). A hung notification host
   *  must not be able to stall the orchestrator's main loop overnight. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * §9.7 — at most one send per channel per minute. Caller passes a
 * shared `RateLimitState` across calls so the limiter survives
 * multiple invocations.
 */
export interface RateLimitState {
  lastPushMs: number;
  lastWebhookMs: number;
}

export function freshRateLimitState(): RateLimitState {
  return { lastPushMs: 0, lastWebhookMs: 0 };
}

const ONE_MINUTE_MS = 60_000;

export async function notify(
  envelope: NotifyEnvelope,
  options: NotifyOptions,
  rateLimit?: RateLimitState,
  now: () => number = Date.now,
): Promise<NotifyResult[]> {
  const f = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = now();

  // Parallel: a misconfigured URL hitting the 10s timeout used to
  // serialize both channels (worst case 20s). Both channels are
  // independent, so fire concurrently. Rate-limit state is updated
  // at attempt-start (before await), so concurrent invocations of
  // notify() — should they ever happen — see consistent state.
  const tasks: Promise<NotifyResult>[] = [];

  if (options.pushUrl) {
    if (rateLimit && rateLimit.lastPushMs > 0 && t - rateLimit.lastPushMs < ONE_MINUTE_MS) {
      tasks.push(Promise.resolve({
        channel: "push", ok: false, status: null,
        error: "rate-limited (local)", rateLimited: true,
      }));
    } else {
      if (rateLimit) rateLimit.lastPushMs = t;
      tasks.push(postOne(f, options.pushUrl, "push", {
        bodyType: "text/plain",
        body: envelope.summary,
        timeoutMs,
      }));
    }
  }
  if (options.webhookUrl) {
    if (rateLimit && rateLimit.lastWebhookMs > 0 && t - rateLimit.lastWebhookMs < ONE_MINUTE_MS) {
      tasks.push(Promise.resolve({
        channel: "webhook", ok: false, status: null,
        error: "rate-limited (local)", rateLimited: true,
      }));
    } else {
      if (rateLimit) rateLimit.lastWebhookMs = t;
      tasks.push((async (): Promise<NotifyResult> => {
        const trail = typeof envelope.trail === "function" ? await envelope.trail() : envelope.trail;
        const resolved = { ...envelope, trail };
        return postOne(f, options.webhookUrl, "webhook", {
          bodyType: "application/json",
          body: JSON.stringify(resolved),
          timeoutMs,
        });
      })());
    }
  }
  return Promise.all(tasks);
}

async function postOne(
  f: typeof fetch,
  url: string,
  channel: "push" | "webhook",
  payload: { bodyType: string; body: string; timeoutMs: number },
): Promise<NotifyResult> {
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": payload.bodyType },
      body: payload.body,
      signal: AbortSignal.timeout(payload.timeoutMs),
    });
    return { channel, ok: res.ok, status: res.status };
  } catch (err) {
    const e = err as Error;
    const error = e.name === "TimeoutError" || e.name === "AbortError"
      ? `timeout after ${payload.timeoutMs}ms`
      : e.message;
    return { channel, ok: false, status: null, error };
  }
}
