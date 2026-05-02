/**
 * Path utilities for design artifacts.
 *
 * All design files live under ./.ccloop/design/ in the target project.
 * This matches the build loop's convention of keeping runtime state in ./.ccloop/
 */

import { join } from "node:path";
import type { DesignPaths } from "./types.ts";

/**
 * Generate design artifact paths for a given project directory.
 *
 * @param cwd - Current working directory (the target project root)
 * @returns Object with absolute paths to all design artifacts
 */
export function getDesignPaths(cwd: string): DesignPaths {
  const designDir = join(cwd, ".ccloop", "design");
  return {
    draft: join(designDir, "spec.draft.md"),
    roadmap: join(designDir, "ROADMAP.md"),
    ideas: join(designDir, "IDEAS.md"),
    techDebt: join(designDir, "TECH-DEBT.md"),
    lastSession: join(designDir, "last-session.md"),
  };
}

/**
 * Get the design directory path.
 *
 * @param cwd - Current working directory
 * @returns Absolute path to ./.ccloop/design/
 */
export function getDesignDir(cwd: string): string {
  return join(cwd, ".ccloop", "design");
}

/**
 * Get the design session metadata path.
 *
 * @param cwd - Current working directory
 * @returns Absolute path to session.json
 */
export function getDesignSessionMetadataPath(cwd: string): string {
  return join(cwd, ".ccloop", "design", "session.json");
}
