import { loadOAuthToken, type DiscoveredToken } from "./loadToken.ts";

export interface InjectAuthResult {
  /** True if either ANTHROPIC_API_KEY or an OAuth token is available. */
  ok: boolean;
  /** Discovered OAuth token (env, keychain, or file), if any. */
  discovered: DiscoveredToken | null;
  /** True if ANTHROPIC_API_KEY was set in the environment. */
  hasApiKey: boolean;
}

/** Discover an OAuth token via the platform-specific sources and
 *  populate `CLAUDE_CODE_OAUTH_TOKEN` so the SDK sees it. Token
 *  discovery already runs before this in production paths, but
 *  `process.env` may not yet reflect a keychain-discovered token —
 *  this helper closes that gap and reports what was found. */
export function injectAuth(): InjectAuthResult {
  const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? "") !== "";
  let discovered: DiscoveredToken | null = null;
  try {
    discovered = loadOAuthToken();
  } catch {
    discovered = null;
  }
  if (discovered && discovered.source !== "env" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = discovered.token;
  }
  const haveToken = discovered !== null && discovered.token !== "";
  return { ok: hasApiKey || haveToken, discovered, hasApiKey };
}
