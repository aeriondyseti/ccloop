import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.ts";
import { ConfigError, DEFAULTS } from "./schema.ts";
import type { RunFlags } from "./flags.ts";

const noFlags: RunFlags = { cont: false, yes: false };

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing ccloop.toml returns defaults", async () => {
    const cfg = await loadConfig(dir, noFlags);
    expect(cfg.loop.max_steps).toBe(DEFAULTS.loop.max_steps);
    expect(cfg.notify.notify_on_done).toBe(false);
  });

  test("present ccloop.toml overrides defaults", async () => {
    await writeFile(
      join(dir, "ccloop.toml"),
      `schema_version = 1\n[loop]\nmax_steps = 7\n[notify]\nnotify_on_done = true\n`,
    );
    const cfg = await loadConfig(dir, noFlags);
    expect(cfg.loop.max_steps).toBe(7);
    expect(cfg.notify.notify_on_done).toBe(true);
  });

  test("malformed toml throws ConfigError", async () => {
    await writeFile(join(dir, "ccloop.toml"), `[loop\nmax_steps = 1\n`);
    await expect(loadConfig(dir, noFlags)).rejects.toBeInstanceOf(ConfigError);
  });

  test("flags override file values", async () => {
    await writeFile(
      join(dir, "ccloop.toml"),
      `schema_version = 1\n[loop]\nmax_steps = 7\n`,
    );
    const cfg = await loadConfig(dir, { ...noFlags, maxSteps: 99 });
    expect(cfg.loop.max_steps).toBe(99);
  });
});
