/**
 * Design loop module.
 *
 * Implements the interactive design session that produces a validated SPEC.md
 * ready for the build loop to consume.
 */

// Types
export type {
  DesignPhase,
  DesignSessionState,
  DesignPaths,
  DesignConfig,
  DesignSessionMetadata,
  DesignSessionResult,
  DesignEvent,
} from "./types.ts";

// Constants
export {
  DESIGN_PHASES,
  DESIGN_ARTIFACT_PATHS,
  DESIGN_SESSION_METADATA_PATH,
  DEFAULT_DESIGN_CONFIG,
} from "./constants.ts";

// Utilities
export {
  getDesignPaths,
  getDesignDir,
  getDesignSessionMetadataPath,
} from "./paths.ts";
