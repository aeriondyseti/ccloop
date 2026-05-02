import { loadOAuthToken, type DiscoveredToken } from "./loadToken.ts";

export interface InjectAuthResult {
  /** True if either ANTHROPIC_API_KEY or an OAuth token is available. */
  ok: boolean;
  /** Discovered OAuth token (env, keychain, or file), if any. */
  discovered: DiscoveredToken | null;
  /** True if ANTHROPIC_API_KEY was set in the environment. */
  hasApiKey: boolean;
}

export interface InjectAuthDeps {
  /** Test seam — defaults to the platform-specific OAuth token loader. */
  load?: () => DiscoveredToken | null;
}

/** Discover an OAuth token via the platform-specific sources and
 *  populate `CLAUDE_CODE_OAUTH_TOKEN` so the SDK sees it. The SDK
 *  reads the env var; this helper closes the gap when the token came
 *  from the macOS keychain or `~/.claude/.credentials.json` rather
 *  than the env directly. */
export function injectAuth(deps: InjectAuthDeps = {}): InjectAuthResult {
  const load = deps.load ?? loadOAuthToken;
  const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? "") !== "";
  let discovered: DiscoveredToken | null = null;
  try {
    discovered = load();
  } catch {
    discovered = null;
  }
  if (discovered && discovered.source !== "env" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = discovered.token;
  }
  const haveToken = discovered !== null && discovered.token !== "";
  return { ok: hasApiKey || haveToken, discovered, hasApiKey };
}
