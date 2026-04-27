/**
 * §12.4 start/resume matrix. Pure decision over filesystem flags
 * (whether `.ccloop/` and `SPEC.md` exist) plus user CLI flags.
 *
 * The CLI layer evaluates the decision, then prompts (or refuses)
 * accordingly.
 */
import { CCLOOP_DIR, SPEC_FILENAME } from "../state/paths.ts";

export interface MatrixInput {
  hasCcloopDir: boolean;
  hasSpec: boolean;
  cont: boolean;          // --continue
}

export type MatrixDecision =
  | { kind: "start_fresh" }                                // .ccloop absent + SPEC present
  | { kind: "resume_no_prompt" }                           // --continue and .ccloop present
  | { kind: "resume_after_confirm" }                       // .ccloop + SPEC both present
  | { kind: "scaffold_or_exit" }                           // SPEC absent + .ccloop absent
  | { kind: "refuse"; reason: string };                    // bad combo

const SPEC_MISSING_REASON =
  `${CCLOOP_DIR}/ exists but ${SPEC_FILENAME} is missing. Restore ${SPEC_FILENAME} or delete ${CCLOOP_DIR}/.`;
const NO_CCLOOP_REASON = `--continue specified but no ${CCLOOP_DIR}/ directory exists.`;

export function decideMatrix(input: MatrixInput): MatrixDecision {
  if (input.cont) {
    if (!input.hasCcloopDir) return { kind: "refuse", reason: NO_CCLOOP_REASON };
    if (!input.hasSpec) return { kind: "refuse", reason: SPEC_MISSING_REASON };
    return { kind: "resume_no_prompt" };
  }
  if (input.hasCcloopDir && input.hasSpec) return { kind: "resume_after_confirm" };
  if (!input.hasCcloopDir && input.hasSpec) return { kind: "start_fresh" };
  if (!input.hasCcloopDir && !input.hasSpec) return { kind: "scaffold_or_exit" };
  return { kind: "refuse", reason: SPEC_MISSING_REASON };
}
