import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, SPEC_FILENAME } from "../state/paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "..", "templates");

export async function runInit(_argv: string[]): Promise<number> {
  const cwd = process.cwd();

  let wrote = 0;
  for (const [src, dst, label] of [
    [join(TEMPLATES_DIR, SPEC_FILENAME), join(cwd, SPEC_FILENAME), SPEC_FILENAME],
    [join(TEMPLATES_DIR, CONFIG_FILENAME), join(cwd, CONFIG_FILENAME), CONFIG_FILENAME],
  ] as const) {
    if (existsSync(dst)) {
      process.stdout.write(`ccloop init: ${label} already exists; skipping.\n`);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    process.stdout.write(`ccloop init: wrote ${label}\n`);
    wrote++;
  }

  if (wrote === 0) {
    process.stdout.write("ccloop init: nothing to do.\n");
  } else {
    process.stdout.write(`\nNext: edit ${SPEC_FILENAME}, then run \`ccloop run\`.\n`);
  }
  return 0;
}
