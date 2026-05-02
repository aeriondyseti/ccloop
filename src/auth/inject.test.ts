import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { injectAuth } from "./inject.ts";
import type { DiscoveredToken } from "./loadToken.ts";

const SAVED_ENV = {
  apiKey: undefined as string | undefined,
  oauth: undefined as string | undefined,
};

describe("injectAuth", () => {
  beforeEach(() => {
    SAVED_ENV.apiKey = process.env.ANTHROPIC_API_KEY;
    SAVED_ENV.oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  afterEach(() => {
    if (SAVED_ENV.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = SAVED_ENV.apiKey;
    if (SAVED_ENV.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = SAVED_ENV.oauth;
  });

  test("ok=false when no token and no api key are present", () => {
    const r = injectAuth({ load: () => null });
    expect(r.ok).toBe(false);
    expect(r.discovered).toBeNull();
    expect(r.hasApiKey).toBe(false);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("ok=true when ANTHROPIC_API_KEY is set, even with no OAuth token", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const r = injectAuth({ load: () => null });
    expect(r.ok).toBe(true);
    expect(r.hasApiKey).toBe(true);
    expect(r.discovered).toBeNull();
  });

  test("keychain-discovered token populates CLAUDE_CODE_OAUTH_TOKEN", () => {
    const token: DiscoveredToken = {
      token: "oat-from-keychain", source: "keychain-macos", detail: "Claude Code-credentials",
    };
    const r = injectAuth({ load: () => token });
    expect(r.ok).toBe(true);
    expect(r.discovered).toEqual(token);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-from-keychain");
  });

  test("file-discovered token populates CLAUDE_CODE_OAUTH_TOKEN", () => {
    const token: DiscoveredToken = {
      token: "oat-from-file", source: "file", detail: "/home/x/.claude/.credentials.json",
    };
    const r = injectAuth({ load: () => token });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-from-file");
  });

  test("env-discovered token does NOT clobber CLAUDE_CODE_OAUTH_TOKEN", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "user-set";
    const token: DiscoveredToken = {
      token: "user-set", source: "env", detail: "CLAUDE_CODE_OAUTH_TOKEN",
    };
    const r = injectAuth({ load: () => token });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("user-set");
    expect(r.ok).toBe(true);
  });

  test("preexisting CLAUDE_CODE_OAUTH_TOKEN is not clobbered by a different keychain token", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "preexisting";
    const token: DiscoveredToken = {
      token: "newer-from-keychain", source: "keychain-macos", detail: "service",
    };
    injectAuth({ load: () => token });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("preexisting");
  });

  test("loader exception is swallowed; ok reflects only env state", () => {
    const r = injectAuth({ load: () => { throw new Error("keychain error"); } });
    expect(r.ok).toBe(false);
    expect(r.discovered).toBeNull();

    process.env.ANTHROPIC_API_KEY = "sk-rescue";
    const r2 = injectAuth({ load: () => { throw new Error("still bad"); } });
    expect(r2.ok).toBe(true);
    expect(r2.hasApiKey).toBe(true);
  });
});
