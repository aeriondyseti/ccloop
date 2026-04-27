import { describe, expect, test } from "bun:test";
import { loadOAuthToken } from "./loadToken.ts";

const VALID_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-from-keychain",
    refreshToken: "r",
    expiresAt: 99999999999999,
    scopes: ["user:profile"],
  },
});

describe("loadOAuthToken", () => {
  test("env var wins over keychain and file", () => {
    const got = loadOAuthToken({
      readEnv: (n) => (n === "CLAUDE_CODE_OAUTH_TOKEN" ? "from-env" : undefined),
      readKeychain: () => VALID_BLOB,
      readFile: () => VALID_BLOB,
      platformName: () => "darwin",
      homeDir: () => "/home/test",
    });
    expect(got).toEqual({ token: "from-env", source: "env", detail: "CLAUDE_CODE_OAUTH_TOKEN" });
  });

  test("macOS keychain used when env missing", () => {
    const got = loadOAuthToken({
      readEnv: () => undefined,
      readKeychain: (s) => (s === "Claude Code-credentials" ? VALID_BLOB : null),
      readFile: () => { throw new Error("should not be reached"); },
      platformName: () => "darwin",
      homeDir: () => "/home/test",
    });
    expect(got?.source).toBe("keychain-macos");
    expect(got?.token).toBe("sk-ant-from-keychain");
  });

  test("falls back to credentials file when keychain empty on macOS", () => {
    const got = loadOAuthToken({
      readEnv: () => undefined,
      readKeychain: () => null,
      readFile: (p) => p === "/home/test/.claude/.credentials.json" ? VALID_BLOB : "",
      platformName: () => "darwin",
      homeDir: () => "/home/test",
    });
    expect(got?.source).toBe("file");
    expect(got?.detail).toBe("/home/test/.claude/.credentials.json");
    expect(got?.token).toBe("sk-ant-from-keychain");
  });

  test("non-macOS skips keychain, reads file", () => {
    let keychainCalls = 0;
    const got = loadOAuthToken({
      readEnv: () => undefined,
      readKeychain: () => { keychainCalls++; return VALID_BLOB; },
      readFile: () => VALID_BLOB,
      platformName: () => "linux",
      homeDir: () => "/home/test",
    });
    expect(keychainCalls).toBe(0);
    expect(got?.source).toBe("file");
  });

  test("CLAUDE_CONFIG_DIR overrides ~/.claude", () => {
    const got = loadOAuthToken({
      readEnv: (n) => n === "CLAUDE_CONFIG_DIR" ? "/custom/dir" : undefined,
      readKeychain: () => null,
      readFile: (p) => p === "/custom/dir/.credentials.json" ? VALID_BLOB : "",
      platformName: () => "linux",
      homeDir: () => "/home/test",
    });
    expect(got?.detail).toBe("/custom/dir/.credentials.json");
  });

  test("returns null when nothing found", () => {
    const got = loadOAuthToken({
      readEnv: () => undefined,
      readKeychain: () => null,
      readFile: () => { throw new Error("ENOENT"); },
      platformName: () => "linux",
      homeDir: () => "/home/test",
    });
    expect(got).toBe(null);
  });

  test("invalid JSON in credentials file falls through", () => {
    const got = loadOAuthToken({
      readEnv: () => undefined,
      readKeychain: () => null,
      readFile: () => "not json",
      platformName: () => "linux",
      homeDir: () => "/home/test",
    });
    expect(got).toBe(null);
  });

  test("missing claudeAiOauth.accessToken returns null", () => {
    const got = loadOAuthToken({
      readEnv: () => undefined,
      readKeychain: () => JSON.stringify({ claudeAiOauth: { foo: "bar" } }),
      readFile: () => { throw new Error("ENOENT"); },
      platformName: () => "darwin",
      homeDir: () => "/home/test",
    });
    expect(got).toBe(null);
  });

  test("empty env var falls through to keychain", () => {
    const got = loadOAuthToken({
      readEnv: (n) => n === "CLAUDE_CODE_OAUTH_TOKEN" ? "" : undefined,
      readKeychain: () => VALID_BLOB,
      readFile: () => { throw new Error("ENOENT"); },
      platformName: () => "darwin",
      homeDir: () => "/home/test",
    });
    expect(got?.source).toBe("keychain-macos");
  });
});
