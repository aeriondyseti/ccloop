/**
 * `ccloop design` entry point.
 *
 * Parses argv, loads config + auth, picks an IoAdapter (stdio or TUI),
 * and hands off to runDesignSession in src/design/orchestrator.ts.
 *
 * MVP scope: stdio adapter is the only adapter wired here. The
 * two-pane Ink TUI ships in src/tui/DesignDashboard.tsx and will be
 * threaded in once it lands; for now `--no-tui` is the only path
 * (and is forced regardless of TTY state).
 */

import { loadConfig } from "../config/load.ts";
import type { RunFlags } from "../config/flags.ts";
import { runDesignSession } from "../design/orchestrator.ts";
import { createStdioAdapter } from "../design/io-stdio.ts";
import { loadOAuthToken } from "../auth/loadToken.ts";

interface DesignFlags {
  help: boolean;
  noTui: boolean;
  modelOverride?: string;
}

export async function runDesign(argv: string[]): Promise<number> {
  let flags: DesignFlags;
  try {
    flags = parseDesignFlags(argv);
  } catch (err) {
    process.stderr.write(`ccloop design: ${(err as Error).message}\n`);
    return 1;
  }

  if (flags.help) {
    process.stdout.write(DESIGN_HELP);
    return 0;
  }

  // OAuth token isn't strictly required (ANTHROPIC_API_KEY also works);
  // loadOAuthToken returns a discovered token or null. The SDK reads
  // CLAUDE_CODE_OAUTH_TOKEN from the environment, so populate it when
  // we discovered one through the keychain / credentials file.
  try {
    const token = loadOAuthToken();
    if (token && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = token.token;
    }
  } catch {
    // surface auth issues from the SDK instead.
  }

  const cwd = process.cwd();
  const designRunFlags: RunFlags = { cont: false, yes: false };
  let config;
  try {
    config = await loadConfig(cwd, designRunFlags);
  } catch (err) {
    process.stderr.write(`ccloop design: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.modelOverride) {
    config = {
      ...config,
      design: { ...config.design, model: flags.modelOverride },
    };
  }

  const abortController = new AbortController();
  const onSigint = () => {
    // First SIGINT: best-effort cancel. Graceful summary handler
    // lands with task #5 (design shutdown) — for now we abort.
    abortController.abort();
  };
  process.on("SIGINT", onSigint);

  const io = createStdioAdapter();
  try {
    const result = await runDesignSession({
      cwd, config, io, abortController,
    });
    if (result.outcome === "accepted") return 0;
    if (result.outcome === "aborted") return 130; // conventional SIGINT exit code
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    await io.close();
  }
}

function parseDesignFlags(argv: string[]): DesignFlags {
  const out: DesignFlags = { help: false, noTui: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--no-tui") { out.noTui = true; continue; }
    if (a === "--model") {
      const v = argv[++i];
      if (!v) throw new Error("--model requires a value");
      out.modelOverride = v;
      continue;
    }
    if (a.startsWith("--model=")) {
      out.modelOverride = a.slice("--model=".length);
      continue;
    }
    throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

export const DESIGN_HELP = `ccloop design — interactive spec-shaping loop

Drives an agent through vision → users → scope → architecture →
milestones → acceptance, producing a validated SPEC.md ready for the
build loop.

Usage:
  ccloop design [flags]

Flags:
  --model NAME            override [design].model from ccloop.toml
  --no-tui                plain stdio fallback (no two-pane layout)
  -h, --help              this help

Output paths:
  ./.ccloop/design/spec.draft.md     in-progress draft
  ./.ccloop/design/last-session.md   summary on graceful exit
  ./SPEC.md                          written on accept + promote
`;
