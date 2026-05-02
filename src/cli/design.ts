/**
 * `ccloop design` entry point.
 *
 * Parses argv, loads config + auth, picks an IoAdapter (stdio or TUI),
 * and hands off to runDesignSession in src/design/orchestrator.ts.
 */

import React from "react";
import { render } from "ink";
import { loadConfig } from "../config/load.ts";
import type { RunFlags } from "../config/flags.ts";
import { runDesignSession } from "../design/orchestrator.ts";
import { createStdioAdapter } from "../design/io-stdio.ts";
import { injectAuth } from "../auth/inject.ts";
import { createDesignTuiBridge } from "../tui/design-bridge.ts";
import { DesignDashboard } from "../tui/DesignDashboard.tsx";
import { createShutdownSignal, type ShutdownSignal } from "../design/shutdown.ts";

interface DesignFlags {
  help: boolean;
  noTui: boolean;
  modelOverride?: string;
}

const FORCE_WINDOW_MS = 2000;

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

  injectAuth();

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
  const shutdown = createShutdownSignal({ abortController });
  const interrupt = createInterruptHandler(shutdown);
  process.on("SIGINT", interrupt);

  const wantsTui = !flags.noTui
    && config.design.enable_tui
    && process.stdout.isTTY === true
    && process.stdin.isTTY === true;

  if (wantsTui) {
    const bridge = createDesignTuiBridge();
    // Ink puts stdin in raw mode, which suppresses Node's SIGINT
    // synthesis — the OS-level handler installed above won't fire
    // until raw mode is released. Route the in-TUI Ctrl+C keystroke
    // through the same two-tier handler so the graceful summary
    // path runs in TUI mode too.
    const inkApp = render(
      React.createElement(DesignDashboard, {
        bridge, cwd,
        onInterrupt: interrupt,
      }),
      { exitOnCtrlC: false },
    );
    try {
      const result = await runDesignSession({
        cwd, config, io: bridge.adapter, abortController, shutdown,
      });
      return exitCodeFor(result.outcome);
    } finally {
      process.off("SIGINT", interrupt);
      inkApp.unmount();
      await inkApp.waitUntilExit().catch(() => undefined);
    }
  }

  const io = createStdioAdapter();
  try {
    const result = await runDesignSession({
      cwd, config, io, abortController, shutdown,
    });
    return exitCodeFor(result.outcome);
  } finally {
    process.off("SIGINT", interrupt);
    await io.close();
  }
}

function exitCodeFor(outcome: "accepted" | "aborted" | "error"): number {
  if (outcome === "accepted") return 0;
  if (outcome === "aborted") return 130;
  return 1;
}

function createInterruptHandler(shutdown: ShutdownSignal): () => void {
  let firstAt = 0;
  return () => {
    const now = Date.now();
    if (firstAt === 0) {
      firstAt = now;
      shutdown.requestGraceful();
      process.stderr.write(
        "\n[ccloop design] Ctrl+C — writing session summary; press again within 2s to force quit.\n",
      );
      return;
    }
    if (now - firstAt <= FORCE_WINDOW_MS) {
      shutdown.forceAbort();
      process.stderr.write("\n[ccloop design] Force quit.\n");
    }
  };
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
