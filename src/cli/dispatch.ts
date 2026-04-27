import { runInit } from "./init.ts";
import { runRun } from "./run.ts";
import { HELP_TEXT } from "./help.ts";

export const VERSION = "0.0.1";

export async function run(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    process.stdout.write(`ccloop ${VERSION}\n`);
    return 0;
  }
  if (first === "init") {
    return await runInit(rest);
  }
  if (first === "run") {
    return await runRun(rest);
  }

  process.stderr.write(`ccloop: unknown subcommand '${first}'\n`);
  process.stderr.write(HELP_TEXT);
  return 1;
}
