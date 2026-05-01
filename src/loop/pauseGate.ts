/**
 * Operator pause gate — a per-instance toggle the orchestrator
 * consults between loop iterations. When set, `runLoop` waits at the
 * top of the next iteration until the gate clears or the run is
 * cancelled.
 *
 * Deliberately not durable: an operator pause is in-memory only. If
 * ccloop is killed while paused, `--continue` resumes running, not
 * paused. This is different from `state.pause` (rate-limit pauses)
 * which IS durable because the rate-limit window outlives the
 * process.
 */

export interface PauseGate {
  isPaused(): boolean;
  /** Toggle paused ↔ running. Returns the new state. */
  toggle(): boolean;
  /** Resolves when the gate is unpaused or the signal aborts. Resolves
   *  immediately if the gate is already unpaused. */
  waitUntilUnpaused(signal: AbortSignal): Promise<void>;
  /** Subscribe to state-change notifications (TUI re-projection). */
  onChange(listener: () => void): () => void;
}

export function createPauseGate(): PauseGate {
  let paused = false;
  const waiters: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const notifyListeners = (): void => {
    for (const l of listeners) {
      try { l(); } catch { /* listener errors must not break the gate */ }
    }
  };
  return {
    isPaused: () => paused,
    toggle: () => {
      paused = !paused;
      if (!paused) {
        const drained = waiters.splice(0, waiters.length);
        for (const w of drained) w();
      }
      notifyListeners();
      return paused;
    },
    waitUntilUnpaused: (signal) => {
      if (!paused) return Promise.resolve();
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const onAbort = (): void => {
          const idx = waiters.indexOf(resolveWaiter);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve();
        };
        const resolveWaiter = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(resolveWaiter);
      });
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
