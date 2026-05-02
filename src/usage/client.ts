/**
 * Anthropic OAuth usage endpoint client per §7.6.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer ${CLAUDE_CODE_OAUTH_TOKEN}
 *   anthropic-beta: oauth-2025-04-20
 *
 * Schema is undocumented and shifts; the validator is deliberately
 * tolerant — unknown fields are ignored, malformed shapes return
 * `kind: "shape_mismatch"` so the loop falls back to reactive-only
 * detection (§7.6 / §14.2).
 *
 * Status mapping: 401 → auth_error (token rotation needed). 403/429 →
 * endpoint_unavailable / rate_limited respectively (the endpoint is
 * known to flap on Max subscribers — §7.6); the loop treats these as
 * non-fatal and falls back to reactive detection.
 */

import { type IsoTimestamp, asIsoTimestamp } from "../branded.ts";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const DEFAULT_CACHE_TTL_MS = 180_000;

export interface UsageWindow {
  utilization: number;       // 0-100
  resets_at: IsoTimestamp;
}

export interface UsageSnapshot {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  fetched_at: number;        // Date.now()
}

export type UsageResult =
  | { kind: "ok"; snapshot: UsageSnapshot }
  | { kind: "rate_limited"; lastGood: UsageSnapshot | null }
  | { kind: "auth_error"; status: number }
  | { kind: "endpoint_unavailable"; status: number; lastGood: UsageSnapshot | null }
  | { kind: "shape_mismatch"; lastGood: UsageSnapshot | null }
  | { kind: "network_error"; error: string; lastGood: UsageSnapshot | null };

export interface UsageClientOptions {
  token: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: read-only injection of the cache. */
  now?: () => number;
  /** Per-request timeout in ms. Caps stalls when the usage endpoint
   *  hangs — overnight, every cache miss calls refresh() and a hung
   *  endpoint would block the orchestrator's main loop. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class UsageClient {
  private cache: UsageSnapshot | null = null;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: UsageClientOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Returns the cached snapshot if still fresh, else fetches. */
  async get(): Promise<UsageResult> {
    if (this.cache && this.now() - this.cache.fetched_at < this.ttlMs) {
      return { kind: "ok", snapshot: this.cache };
    }
    return await this.refresh();
  }

  /** Force-refresh, bypassing the cache window. */
  async refresh(): Promise<UsageResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "anthropic-beta": BETA,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const error = e.name === "TimeoutError" || e.name === "AbortError"
        ? `timeout after ${this.timeoutMs}ms`
        : e.message;
      return { kind: "network_error", error, lastGood: this.cache };
    }

    if (res.status === 429) {
      return { kind: "rate_limited", lastGood: this.cache };
    }
    if (res.status === 401) {
      return { kind: "auth_error", status: res.status };
    }
    if (res.status === 403) {
      // The usage endpoint is known to flap between 403 and 429 for
      // some Max subscribers (§7.6). Treat 403 as endpoint trouble,
      // not token trouble — let the loop fall back to reactive-only.
      return { kind: "endpoint_unavailable", status: res.status, lastGood: this.cache };
    }
    if (!res.ok) {
      return {
        kind: "network_error",
        error: `HTTP ${res.status}`,
        lastGood: this.cache,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { kind: "shape_mismatch", lastGood: this.cache };
    }
    const parsed = parseUsageBody(body, this.now());
    if (!parsed) return { kind: "shape_mismatch", lastGood: this.cache };
    this.cache = parsed;
    return { kind: "ok", snapshot: parsed };
  }

  /** Last known good snapshot, or null. Synchronous; never fetches. */
  lastSnapshot(): UsageSnapshot | null {
    return this.cache;
  }

  /** Test seam. */
  primeCache(snapshot: UsageSnapshot): void {
    this.cache = snapshot;
  }
}

export function parseUsageBody(body: unknown, fetchedAt: number): UsageSnapshot | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const five = parseWindow(b.five_hour);
  const seven = parseWindow(b.seven_day);
  if (!five || !seven) return null;
  return { five_hour: five, seven_day: seven, fetched_at: fetchedAt };
}

function parseWindow(raw: unknown): UsageWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const u = r.utilization;
  const at = r.resets_at;
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  if (typeof at !== "string" || at.length === 0) return null;
  return { utilization: u, resets_at: asIsoTimestamp(at) };
}
