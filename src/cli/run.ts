import { existsSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import React from "react";
import { parseRunFlags } from "../config/flags.ts";
import { loadConfig } from "../config/load.ts";
import { validateSpec } from "../config/spec.ts";
import { decideMatrix } from "./matrix.ts";
import { confirmDefaultYes } from "./prompt.ts";
import { runInit } from "./init.ts";
import { CCLOOP_DIR, CONFIG_FILENAME, SPEC_FILENAME, runtimePaths } from "../state/paths.ts";
import {
  autoCommit, initRepoEmpty, isGitRepo, isWorkingTreeClean,
} from "../loop/git.ts";
import { acquireLock, LockHeldError } from "../state/lock.ts";
import { LoopDriver } from "../loop/driver.ts";
import { runLoop } from "../loop/orchestrator.ts";
import { EventBus } from "../loop/eventBus.ts";
import { UsageClient } from "../usage/client.ts";
import { Dashboard } from "../tui/Dashboard.tsx";
import { project } from "../tui/projector.ts";
import { EMPTY_VIEW } from "../tui/types.ts";
import type { TuiViewModel } from "../tui/types.ts";
import type { CcloopState } from "../state/state.ts";
import { findLastGreenSha, loadRecentSteps } from "../state/stepLoader.ts";
import { readSingleKey } from "./keys.ts";
import { decideEscalationKey, resetForContinue } from "../loop/escalation.ts";
import { hardReset } from "../loop/git.ts";
import { writeState } from "../state/state.ts";
import { spawnSync } from "node:child_process";

const TUI_TICK_MS = 250;

export async function runRun(argv: string[]): Promise<number> {
  let flags;
  try {
    flags = parseRunFlags(argv);
  } catch (err) {
    process.stderr.write(`ccloop run: ${(err as Error).message}\n`);
    return 1;
  }

  const cwd = process.cwd();

  // 1. SPEC.md + .ccloop/ matrix per §12.4.
  const hasCcloopDir = existsSync(join(cwd, CCLOOP_DIR));
  const hasSpec = existsSync(join(cwd, SPEC_FILENAME));
  const decision = decideMatrix({ hasCcloopDir, hasSpec, cont: flags.cont });

  if (decision.kind === "refuse") {
    process.stderr.write(`ccloop: ${decision.reason}\n`);
    return 1;
  }
  if (decision.kind === "scaffold_or_exit") {
    const yes = await confirmDefaultYes(`No ${SPEC_FILENAME} found. Scaffold?`, flags.yes);
    if (!yes) return 0;
    const code = await runInit([]);
    if (code !== 0) return code;
    process.stdout.write(`Edit ${SPEC_FILENAME}, then run \`ccloop run\`.\n`);
    return 0;
  }
  if (decision.kind === "resume_after_confirm") {
    const yes = await confirmDefaultYes(
      "Existing run found. Continue?",
      flags.yes,
    );
    if (!yes) return 0;
  }

  // 2. Load config + validate spec.
  let config;
  try {
    config = await loadConfig(cwd, flags);
  } catch (err) {
    process.stderr.write(`ccloop: ${(err as Error).message}\n`);
    return 1;
  }
  const specCheck = await validateSpec(cwd);
  if (!specCheck.ok) {
    process.stderr.write(`ccloop: ${specCheck.error}\n`);
    return 1;
  }

  // 3. Auth gate.
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!token && !apiKey) {
    process.stderr.write(
      "ccloop: missing auth. Set CLAUDE_CODE_OAUTH_TOKEN (recommended; run `claude setup-token`) or ANTHROPIC_API_KEY.\n",
    );
    return 2;
  }

  // 4. Git repo + dirty-tree gate per §0 / §10.4.
  if (!(await isGitRepo(cwd))) {
    if (await isCwdGreenfield(cwd)) {
      process.stdout.write("ccloop: empty CWD, running git init…\n");
      try {
        await initRepoEmpty(cwd);
      } catch (err) {
        process.stderr.write(`ccloop: ${(err as Error).message}\n`);
        return 1;
      }
    } else {
      process.stderr.write(
        "ccloop: CWD has files but no .git/. Initialize git manually before running ccloop.\n",
      );
      return 1;
    }
  } else if (decision.kind !== "resume_after_confirm" && decision.kind !== "resume_no_prompt") {
    if (!(await isWorkingTreeClean(cwd))) {
      process.stderr.write(
        "ccloop: working tree is dirty. Commit or stash before starting a fresh run (`git status`).\n",
      );
      return 1;
    }
  }
  // §10.4 recovery commit: --continue with a dirty tree means the
  // previous instance was killed mid-step. Auto-commit whatever's
  // there before resuming so the loop has a clean baseline. Step
  // number is filled in once state is loaded (see below).
  const isResume = decision.kind === "resume_after_confirm" || decision.kind === "resume_no_prompt";
  const needsRecoveryCommit = isResume && !(await isWorkingTreeClean(cwd));

  // 5. Set caching env opt-in per §6.6.
  process.env.ENABLE_PROMPT_CACHING_1H = process.env.ENABLE_PROMPT_CACHING_1H ?? "1";

  // 6. Lock.
  const paths = runtimePaths(cwd);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(paths.lock);
  } catch (err) {
    if (err instanceof LockHeldError) {
      process.stderr.write(`ccloop: ${err.message}\n`);
      return 3;
    }
    process.stderr.write(`ccloop: ${(err as Error).message}\n`);
    return 1;
  }

  // 7. Build driver, bus, optional usage client.
  const bus = new EventBus<import("../loop/driver.ts").DriverEvent>();
  const driver = new LoopDriver(cwd, paths, config, bus);
  const state = await driver.loadOrInitState();

  if (needsRecoveryCommit) {
    try {
      const r = await autoCommit(
        cwd,
        `chore(ccloop): recovery commit before resume of step ${state.current_step}`,
      );
      if (r.committed) {
        process.stderr.write(
          `ccloop: recovered dirty tree into commit ${r.sha.slice(0, 7)}.\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`ccloop: recovery commit failed: ${(err as Error).message}\n`);
      if (release) await release();
      return 1;
    }
  }

  const usageClient = token
    ? new UsageClient({ token })
    : null;

  // 8. SIGINT/SIGTERM handler — propagate via AbortController.
  const aborter = new AbortController();
  let exitSignalCode = 0;
  const onSig = (code: number) => () => {
    exitSignalCode = code;
    aborter.abort();
  };
  const onSigInt = onSig(130);
  const onSigTerm = onSig(143);
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  // 9. TUI: render via ink, ticked by the bus + 250ms timer.
  let view: TuiViewModel = { ...EMPTY_VIEW, cwd, runId: state.run_id, step: state.current_step };
  let recentEvents: string[] = [];
  let finalCommitSha = "";
  let stepsDirty = true;
  let cachedRecent: import("../loop/stepRecord.ts").StepRecord[] = [];
  bus.subscribe((e) => {
    recentEvents = [...recentEvents, eventToLine(e)].slice(-12);
    if (e.type === "step_end") stepsDirty = true;
    if (e.type === "done" && "final_commit_sha" in e) {
      finalCommitSha = String(e.final_commit_sha);
    }
  });
  const ink = render(React.createElement(Dashboard, { view }));
  if (usageClient) void usageClient.get();
  const usagePollTimer = usageClient ? setInterval(() => {
    void usageClient.get();
  }, 30_000) : null;
  const tickTimer = setInterval(async () => {
    if (stepsDirty) {
      cachedRecent = await loadRecentSteps(paths.steps, 5);
      stepsDirty = false;
    }
    view = buildView(state, cwd, usageClient, recentEvents, cachedRecent, finalCommitSha);
    ink.rerender(React.createElement(Dashboard, { view }));
  }, TUI_TICK_MS);

  // 10. Drive the loop, handling escalation cycles.
  let exitCode = 0;
  try {
    let resolved = false;
    while (!resolved) {
      const outcome = await runLoop(state, {
        config, paths, driver, bus, abortSignal: aborter.signal,
        usage: usageClient,
        notifyOptions: { pushUrl: config.notify.push_url, webhookUrl: config.notify.webhook_url },
      });
      if (outcome.kind === "done") { exitCode = 0; resolved = true; }
      else if (outcome.kind === "guardrail_trip") { exitCode = 4; resolved = true; }
      else if (outcome.kind === "cancelled") {
        exitCode = exitSignalCode || 130;
        resolved = true;
      }
      else if (outcome.kind === "escalated") {
        const action = await handleEscalation(state, paths, cwd, aborter.signal);
        if (action === "quit") { exitCode = 5; resolved = true; }
        // continue / revert / edit_spec → loop again with reset state
      }
    }
  } catch (err) {
    process.stderr.write(`\nccloop: fatal error: ${(err as Error).message}\n`);
    exitCode = 1;
  } finally {
    clearInterval(tickTimer);
    if (usagePollTimer) clearInterval(usagePollTimer);
    cachedRecent = await loadRecentSteps(paths.steps, 5);
    view = buildView(state, cwd, usageClient, recentEvents, cachedRecent, finalCommitSha);
    ink.rerender(React.createElement(Dashboard, { view }));
    ink.unmount();
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (release) await release();
  }
  return exitCode;
}

async function isCwdGreenfield(cwd: string): Promise<boolean> {
  // Empty, or only SPEC.md / ccloop.toml / .ccloop/ present.
  const allowed = new Set([SPEC_FILENAME, CONFIG_FILENAME, CCLOOP_DIR]);
  const entries = await Array.fromAsync(
    new Bun.Glob("*").scan({ cwd, dot: false, onlyFiles: false }),
  );
  for (const name of entries) {
    if (!allowed.has(name)) return false;
  }
  return true;
}

function eventToLine(e: { ts: string; type: string } & Record<string, unknown>): string {
  const t = e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
  return `${t}  ${e.type}`;
}

async function handleEscalation(
  state: CcloopState,
  paths: ReturnType<typeof runtimePaths>,
  cwd: string,
  abortSignal: AbortSignal,
): Promise<"continue" | "quit"> {
  const key = await readSingleKey(["c", "r", "e", "q"], abortSignal);
  if (abortSignal.aborted) return "quit";
  const lastGreen = await findLastGreenSha(paths.steps);
  const action = decideEscalationKey(key, state, lastGreen);
  switch (action.kind) {
    case "quit":
      return "quit";
    case "continue":
      resetForContinue(state);
      await writeState(paths.state, state);
      return "continue";
    case "revert":
      try {
        await hardReset(cwd, action.sha);
      } catch (err) {
        process.stderr.write(`\nccloop: revert failed: ${(err as Error).message}\n`);
        return "quit";
      }
      resetForContinue(state);
      await writeState(paths.state, state);
      return "continue";
    case "edit_spec": {
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const r = spawnSync(editor, [join(cwd, SPEC_FILENAME)], { stdio: "inherit" });
      if (r.status !== 0) {
        process.stderr.write(`\nccloop: editor exited ${r.status}; staying in escalated state.\n`);
        return "quit";
      }
      resetForContinue(state);
      await writeState(paths.state, state);
      return "continue";
    }
  }
}

function buildView(
  state: CcloopState,
  cwd: string,
  usage: UsageClient | null,
  events: string[],
  recent: import("../loop/stepRecord.ts").StepRecord[],
  finalCommitSha: string,
): TuiViewModel {
  const snapshot = usage?.lastSnapshot() ?? null;
  return project({
    state,
    cwd,
    usage: snapshot,
    recent,
    events,
    now: new Date(),
    finalCommitSha,
  });
}
