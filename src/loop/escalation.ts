/**
 * Process the §9.6 escalation single-key controls into a state
 * transition. Pure decision; the caller wires it into the
 * orchestrator + git actions.
 */
import type { CcloopState } from "../state/state.ts";
import type { Sha } from "../branded.ts";

export type EscalationKeyAction =
  | { kind: "continue" }                       // resume RUNNING at next step
  | { kind: "revert"; sha: Sha }               // git reset --hard <sha>; then continue
  | { kind: "edit_spec" }                      // open $EDITOR on SPEC.md, then continue
  | { kind: "quit" };                          // persist + exit 5

export function decideEscalationKey(
  key: string,
  state: CcloopState,
  lastGreenSha: Sha | null,
): EscalationKeyAction {
  switch (key.toLowerCase()) {
    case "c":
      return { kind: "continue" };
    case "r":
      if (!lastGreenSha) return { kind: "quit" };
      return { kind: "revert", sha: lastGreenSha };
    case "e":
      return { kind: "edit_spec" };
    case "q":
    default:
      return { kind: "quit" };
  }
}

/** Reset the failure counters back to RUNNING per §9.6 `c`. Clears
 *  `last_failure` too — once the operator acknowledges and continues,
 *  the next prompt's `{{last_error}}` block must not still describe
 *  the resolved failure. */
export function resetForContinue(state: CcloopState): void {
  state.consecutive_failures = 0;
  state.no_progress_count = 0;
  state.diff_hashes_recent = [];
  state.escalation = null;
  state.last_failure = null;
  state.state = "running";
}

/** After a `revert` or `edit_spec` escalation action, clear the SDK
 *  session id so the next step opens a fresh session. The resumed
 *  session would otherwise still hold context that disagrees with
 *  the new working tree (rolled-back changes) or new spec (pre-edit
 *  cached spec). */
export function clearSessionForReorientation(state: CcloopState): void {
  state.session_id = null;
  state.steps_since_session_reset = 0;
}
