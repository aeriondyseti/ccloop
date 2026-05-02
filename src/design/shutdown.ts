/**
 * Graceful shutdown signal for the design loop.
 *
 * Ctrl+C semantics (per ./SPEC.md "Graceful shutdown"):
 *   1. First Ctrl+C: ask the agent to write a summary of the session
 *      to ./.ccloop/design/last-session.md, then exit cleanly.
 *   2. Second Ctrl+C within 2s: hard-kill — abort the SDK mid-stream,
 *      draft preserved, no summary.
 *
 * The CLI translates SIGINT into either `requestGraceful()` or
 * `forceAbort()` on this signal. The orchestrator checks
 * `requested`/`abortSignal.aborted` at well-defined points and races
 * the user-input wait against `whenRequested()`. This keeps
 * SIGINT-handling code out of the orchestrator.
 */

export interface ShutdownSignal {
  /** True after the first Ctrl+C has been observed. */
  readonly requested: boolean;
  /** Promise that resolves when graceful shutdown is requested.
   *  Used by the orchestrator to race against `getNextInput()`. */
  whenRequested(): Promise<void>;
  /** AbortSignal that fires on the second Ctrl+C (hard kill). */
  readonly abortSignal: AbortSignal;
  /** The underlying controller. Exposed so the orchestrator can pass
   *  it to the SDK as `Options.abortController`, guaranteeing
   *  `forceAbort()` actually reaches the in-flight query — even when
   *  the caller didn't supply its own controller. */
  readonly abortController: AbortController;
  /** Trip the graceful-shutdown flag. Idempotent. */
  requestGraceful(): void;
  /** Trip the hard-abort signal. Idempotent. */
  forceAbort(): void;
}

export interface CreateShutdownSignalOptions {
  /** Inject an external AbortController so callers can also force-abort
   *  it for reasons unrelated to SIGINT (e.g. timeout). */
  abortController?: AbortController;
}

export function createShutdownSignal(
  opts: CreateShutdownSignalOptions = {},
): ShutdownSignal {
  const ac = opts.abortController ?? new AbortController();
  let requested = false;
  let resolveWhen: (() => void) | null = null;
  const whenPromise = new Promise<void>((resolve) => {
    resolveWhen = resolve;
  });
  return {
    get requested() { return requested; },
    get abortSignal() { return ac.signal; },
    get abortController() { return ac; },
    whenRequested: () => whenPromise,
    requestGraceful() {
      if (requested) return;
      requested = true;
      resolveWhen?.();
    },
    forceAbort() {
      if (ac.signal.aborted) return;
      ac.abort();
    },
  };
}

/** Sentinel returned by `getNextInput`-or-shutdown race so the
 *  orchestrator can branch on which side won. */
export const SHUTDOWN_TICK = Symbol("design.shutdown.tick");

/** Race a getNextInput() call against the shutdown signal. Returns
 *  the input string (or null on EOF) if the user replied first, or
 *  SHUTDOWN_TICK if shutdown was requested. */
export async function awaitInputOrShutdown(
  inputPromise: Promise<string | null>,
  shutdown: ShutdownSignal,
): Promise<string | null | typeof SHUTDOWN_TICK> {
  if (shutdown.requested) return SHUTDOWN_TICK;
  return await Promise.race<string | null | typeof SHUTDOWN_TICK>([
    inputPromise,
    shutdown.whenRequested().then(() => SHUTDOWN_TICK),
  ]);
}

/** Prompt sent to the agent on graceful shutdown. The design approver
 *  hook permits writes under .ccloop/design/, so the agent can use
 *  the standard Write tool to materialize the summary. */
export const SHUTDOWN_SUMMARY_PROMPT =
  "The user has signaled graceful shutdown (Ctrl+C). Write a concise session " +
  "summary to `./.ccloop/design/last-session.md` covering: (1) decisions made, " +
  "(2) open questions, (3) where the conversation left off so it can be resumed " +
  "later. Use the Write tool. Keep it under 500 words. Do not call ask_user. " +
  "After writing the file, reply with one short sentence confirming the summary " +
  "is on disk.";
