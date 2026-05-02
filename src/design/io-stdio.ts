/**
 * Plain-stdio IoAdapter for `ccloop design --no-tui` and non-TTY environments.
 *
 * Renders the agent transcript inline, prompts the user via readline,
 * and serializes ask_user widgets as numbered menus. No live draft pane.
 */
import readline from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type { IoAdapter } from "./io.ts";
import type { AskUserInput, AskUserResult } from "../mcp/ask-user.ts";

export interface StdioAdapterOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
}

export function createStdioAdapter(opts: StdioAdapterOptions = {}): IoAdapter {
  const stdin = opts.input ?? process.stdin;
  const stdout = opts.output ?? process.stdout;
  const stderr = opts.errorOutput ?? process.stderr;

  const rl: ReadlineInterface = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: false,
  });

  function write(text: string): void {
    stdout.write(text);
  }

  async function readLine(prompt: string): Promise<string | null> {
    write(prompt);
    return await new Promise<string | null>((resolve) => {
      const onLine = (line: string) => {
        rl.off("close", onClose);
        resolve(line);
      };
      const onClose = () => {
        rl.off("line", onLine);
        resolve(null);
      };
      rl.once("line", onLine);
      rl.once("close", onClose);
    });
  }

  return {
    showAssistantText(text) {
      if (!text.trim()) return;
      write(`\n${text}\n`);
    },
    showToolUse(name, summary) {
      write(`\n  · ${name}${summary ? `: ${summary}` : ""}\n`);
    },
    showInfo(text) {
      write(`\n[info] ${text}\n`);
    },
    showError(text) {
      stderr.write(`\n[error] ${text}\n`);
    },
    draftUpdated(_content) {
      // Stdio mode doesn't show a live draft pane; the agent will
      // mention edits in its prose. No-op here is intentional.
    },
    async askUser(input: AskUserInput): Promise<AskUserResult> {
      write(`\n? ${input.question}\n`);
      input.options.forEach((opt, i) => {
        write(`  ${i + 1}) ${opt.label} — ${opt.description}\n`);
      });
      const hint = input.multi_select
        ? "Enter comma-separated numbers (e.g. 1,3), or text for freeform: "
        : "Enter a number, or text for freeform: ";
      const raw = await readLine(hint);
      if (raw === null) return { selected: [] };
      const trimmed = raw.trim();
      if (!trimmed) return { selected: [] };

      const numbers = parseNumberList(trimmed, input.options.length);
      if (numbers.length === 0) {
        // Freeform path: user typed something other than indices.
        return { selected: [], freeform: trimmed };
      }
      const picks = numbers.map((n) => input.options[n - 1]?.label ?? "");
      // Single-select but multiple numbers: take the first.
      return {
        selected: input.multi_select ? picks : picks.slice(0, 1),
      };
    },
    async getNextInput() {
      return await readLine("\nyou> ");
    },
    async confirm(question, defaultYes) {
      const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
      const raw = await readLine(`\n${question}${suffix}`);
      if (raw === null) return false;
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === "") return defaultYes;
      return trimmed === "y" || trimmed === "yes";
    },
    async close() {
      rl.close();
    },
  };
}

/** Parse "1,3,2" → [1,3,2], rejecting any out-of-range index.
 *  Returns [] if anything is non-numeric so the caller can fall back
 *  to treating the whole string as freeform. */
function parseNumberList(input: string, max: number): number[] {
  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return [];
    const n = Number(part);
    if (n < 1 || n > max) return [];
    nums.push(n);
  }
  return nums;
}
