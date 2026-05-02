/**
 * Discover an Anthropic OAuth bearer token for ccloop.
 *
 * Precedence:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (the `claude setup-token` path —
 *      the documented headless option, no expiry).
 *   2. macOS keychain service `Claude Code-credentials` (the
 *      `claude /login` path; only consulted on darwin).
 *   3. ${CLAUDE_CONFIG_DIR ?? ~/.claude}/.credentials.json (the
 *      `claude /login` path on Linux/Windows, or fallback on macOS
 *      systems that store credentials to disk instead of keychain).
 *
 * Mirrors ccstatusline (sirmalloc/ccstatusline/src/utils/usage-fetch.ts).
 * No expiry handling — Anthropic does not publish a refresh endpoint
 * and ccstatusline does not refresh either. If the token is expired
 * the request will return 401 and the orchestrator will escalate
 * with a token-rotation prompt (existing behavior).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type TokenSource = "env" | "keychain-macos" | "file";

export interface DiscoveredToken {
  token: string;
  source: TokenSource;
  /** Resolved source path or service for logging; e.g. file path. */
  detail: string;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILENAME = ".credentials.json";

/** Test seam — defaults to OS-level execFile. */
export interface LoadTokenDeps {
  readEnv?: (name: string) => string | undefined;
  readFile?: (path: string) => string;
  readKeychain?: (service: string) => string | null;
  platformName?: () => NodeJS.Platform;
  homeDir?: () => string;
}

export function loadOAuthToken(deps: LoadTokenDeps = {}): DiscoveredToken | null {
  const readEnv = deps.readEnv ?? ((n) => process.env[n]);
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const readKeychain = deps.readKeychain ?? defaultReadKeychain;
  const plat = deps.platformName ?? platform;
  const home = deps.homeDir ?? homedir;

  // 1. env var.
  const envToken = readEnv("CLAUDE_CODE_OAUTH_TOKEN");
  if (envToken && envToken.length > 0) {
    return { token: envToken, source: "env", detail: "CLAUDE_CODE_OAUTH_TOKEN" };
  }

  // 2. macOS keychain.
  if (plat() === "darwin") {
    const raw = readKeychain(KEYCHAIN_SERVICE);
    const token = raw ? extractAccessToken(raw) : null;
    if (token) {
      return { token, source: "keychain-macos", detail: KEYCHAIN_SERVICE };
    }
  }

  // 3. credentials file.
  const configDir = readEnv("CLAUDE_CONFIG_DIR") || join(home(), ".claude");
  const credPath = join(configDir, CREDENTIALS_FILENAME);
  try {
    const raw = readFile(credPath);
    const token = extractAccessToken(raw);
    if (token) return { token, source: "file", detail: credPath };
  } catch {
    // file missing or unreadable — fall through.
  }

  return null;
}

function defaultReadKeychain(service: string): string | null {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

function extractAccessToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const root = parsed as Record<string, unknown>;
    const oauth = root.claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) return null;
    const at = (oauth as Record<string, unknown>).accessToken;
    if (typeof at !== "string" || at.length === 0) return null;
    return at;
  } catch {
    return null;
  }
}
