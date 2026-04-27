/**
 * Tiny default-yes prompt used by the §12.4 start/resume matrix. Reads
 * one line from stdin. If stdin isn't a TTY or `assumeYes` is on, the
 * default is taken without asking.
 */
import * as readline from "node:readline/promises";

export async function confirmDefaultYes(
  question: string,
  assumeYes: boolean,
): Promise<boolean> {
  if (assumeYes) {
    process.stdout.write(`${question} [Y/n] (auto-yes)\n`);
    return true;
  }
  if (!process.stdin.isTTY) {
    process.stdout.write(`${question} [Y/n] (non-tty, defaulting yes)\n`);
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
