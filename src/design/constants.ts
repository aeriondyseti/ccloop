/**
 * Constants for the design loop.
 */

import type { DesignPhase, DesignPaths } from "./types.ts";

/**
 * Design phases in linear order.
 * The agent is instructed to complete each phase before advancing to the next.
 */
export const DESIGN_PHASES: readonly DesignPhase[] = [
  "vision",
  "users",
  "scope",
  "architecture",
  "milestones",
  "acceptance",
] as const;

/**
 * Relative paths for design artifacts within ./.ccloop/design/
 */
export const DESIGN_ARTIFACT_PATHS: DesignPaths = {
  draft: "./.ccloop/design/spec.draft.md",
  roadmap: "./.ccloop/design/ROADMAP.md",
  ideas: "./.ccloop/design/IDEAS.md",
  techDebt: "./.ccloop/design/TECH-DEBT.md",
  lastSession: "./.ccloop/design/last-session.md",
};

/**
 * Design session metadata file.
 * Used for resume functionality.
 */
export const DESIGN_SESSION_METADATA_PATH = "./.ccloop/design/session.json";

/**
 * Default configuration values for design sessions.
 */
export const DEFAULT_DESIGN_CONFIG = {
  model: "claude-opus-4-20250514",
  max_turns: 100, // Generous limit for interactive sessions
  effort: "high",
} as const;
