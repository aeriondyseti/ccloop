/** Path utilities for design artifacts. All design files live under
 *  ./.ccloop/design/ in the target project, matching the build loop's
 *  convention of keeping runtime state under ./.ccloop/. */

import { join } from "node:path";
import type { DesignPaths } from "./types.ts";

export function getDesignPaths(cwd: string): DesignPaths {
  const designDir = getDesignDir(cwd);
  return {
    draft: join(designDir, "spec.draft.md"),
    roadmap: join(designDir, "ROADMAP.md"),
    ideas: join(designDir, "IDEAS.md"),
    techDebt: join(designDir, "TECH-DEBT.md"),
    lastSession: join(designDir, "last-session.md"),
  };
}

export function getDesignDir(cwd: string): string {
  return join(cwd, ".ccloop", "design");
}
