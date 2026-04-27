import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type CcloopConfig, ConfigError, mergeConfig } from "./schema.ts";
import type { RunFlags } from "./flags.ts";
import { isENOENT } from "../errors.ts";
import { CONFIG_FILENAME } from "../state/paths.ts";

export async function loadConfig(cwd: string, flags: RunFlags): Promise<CcloopConfig> {
  const path = join(cwd, CONFIG_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return applyFlags(mergeConfig(undefined), flags);
    throw new ConfigError(`failed to read ${CONFIG_FILENAME}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new ConfigError(`failed to parse ${CONFIG_FILENAME}: ${(err as Error).message}`);
  }
  return applyFlags(mergeConfig(raw), flags);
}

export function applyFlags(cfg: CcloopConfig, flags: RunFlags): CcloopConfig {
  if (flags.maxSteps !== undefined) cfg.loop.max_steps = flags.maxSteps;
  if (flags.maxWallClock !== undefined) cfg.loop.max_wall_clock = flags.maxWallClock;
  if (flags.cadence !== undefined) cfg.loop.target_cadence_seconds = flags.cadence;
  if (flags.yolo === true) cfg.claude.yolo_mode = true;
  if (flags.promptPath !== undefined) cfg.prompt.template_path = flags.promptPath;
  return cfg;
}
