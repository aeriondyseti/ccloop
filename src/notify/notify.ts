/**
 * §9.7 — push and webhook notifiers. Best-effort: logs and continues
 * on failure. Rate-limited to one per channel per minute (the loop
 * driver decides when to call us; we don't track time globally).
 */

export interface NotifyEnvelope {
  run_id: string;
  step: number;
  reason: string;
  trail: unknown[];
  /** Free-form short summary for push body. */
  summary: string;
}

export interface NotifyResult {
  channel: "push" | "webhook";
  ok: boolean;
  status: number | null;
  error?: string;
}

export interface NotifyOptions {
  pushUrl: string;
  webhookUrl: string;
  fetchImpl?: typeof fetch;
}

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
  const results: NotifyResult[] = [];
  const f = options.fetchImpl ?? fetch;
  const t = now();

  if (options.pushUrl) {
    if (rateLimit && rateLimit.lastPushMs > 0 && t - rateLimit.lastPushMs < ONE_MINUTE_MS) {
      results.push({ channel: "push", ok: false, status: null, error: "rate-limited (local)" });
    } else {
      results.push(await postOne(f, options.pushUrl, "push", {
        bodyType: "text/plain",
        body: envelope.summary,
      }));
      if (rateLimit) rateLimit.lastPushMs = t;
    }
  }
  if (options.webhookUrl) {
    if (rateLimit && rateLimit.lastWebhookMs > 0 && t - rateLimit.lastWebhookMs < ONE_MINUTE_MS) {
      results.push({ channel: "webhook", ok: false, status: null, error: "rate-limited (local)" });
    } else {
      results.push(await postOne(f, options.webhookUrl, "webhook", {
        bodyType: "application/json",
        body: JSON.stringify(envelope),
      }));
      if (rateLimit) rateLimit.lastWebhookMs = t;
    }
  }
  return results;
}

async function postOne(
  f: typeof fetch,
  url: string,
  channel: "push" | "webhook",
  payload: { bodyType: string; body: string },
): Promise<NotifyResult> {
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": payload.bodyType },
      body: payload.body,
    });
    return { channel, ok: res.ok, status: res.status };
  } catch (err) {
    return { channel, ok: false, status: null, error: (err as Error).message };
  }
}
