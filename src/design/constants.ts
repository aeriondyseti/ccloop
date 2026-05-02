import type { DesignPhase, DesignPaths } from "./types.ts";

export const DESIGN_PHASES: readonly DesignPhase[] = [
  "vision",
  "users",
  "scope",
  "architecture",
  "milestones",
  "acceptance",
] as const;

export const DESIGN_ARTIFACT_PATHS: DesignPaths = {
  draft: "./.ccloop/design/spec.draft.md",
  roadmap: "./.ccloop/design/ROADMAP.md",
  ideas: "./.ccloop/design/IDEAS.md",
  techDebt: "./.ccloop/design/TECH-DEBT.md",
  lastSession: "./.ccloop/design/last-session.md",
};

export const DEFAULT_DESIGN_CONFIG = {
  model: "claude-opus-4-20250514",
  // Generous default — interactive sessions that hit the cap are
  // not a productive failure mode.
  max_turns: 100,
  effort: "high",
} as const;
