/**
 * Design loop module.
 *
 * Implements the interactive design session that produces a validated SPEC.md
 * ready for the build loop to consume.
 */

export type {
  DesignPhase,
  DesignPaths,
  DesignConfig,
  DesignSessionResult,
  DesignEvent,
} from "./types.ts";

export {
  DESIGN_PHASES,
  DESIGN_ARTIFACT_PATHS,
  DEFAULT_DESIGN_CONFIG,
} from "./constants.ts";

export {
  getDesignPaths,
  getDesignDir,
} from "./paths.ts";

export { DESIGN_SYSTEM_PROMPT } from "./prompts.ts";

export {
  initializeDraft,
  loadDraft,
  loadDraftIfExists,
  validateDraft,
  promoteDraft,
  saveDraft,
} from "./draft.ts";

export {
  DesignEventEmitter,
  createDesignEventEmitter,
} from "./events.ts";

export {
  makeDesignApprover,
  type DesignApproverOptions,
} from "./approver.ts";

export {
  acceptDraft,
  checkDraftValidity,
  formatValidationError,
  generateAcceptancePrompt,
  type AcceptanceResult,
} from "./acceptance.ts";
