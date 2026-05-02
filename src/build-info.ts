/**
 * Single source of truth for build identity. Used to gate dev-only
 * features (the `--debug` flag, `debug:*` subcommands) so they're
 * unreachable from a production npm install while still available
 * during local development and from `@dev`-tagged prereleases.
 *
 * Detection rules:
 *   - **Prerelease version** (e.g. `0.1.0-dev.42`, `1.0.0-rc.1`) →
 *     dev. Matches CI's `<base>-dev.<run_number>` auto-suffix on
 *     pushes to the `dev` branch.
 *   - **Adjacent `.git/`** → dev. Catches local working trees;
 *     `npm publish` strips `.git/` so installed packages never
 *     match this branch.
 *   - **Otherwise** → production. The `@latest` install path.
 *
 * Either signal is sufficient. No environment-variable override on
 * purpose: if a user wants debug behaviour on a prod install,
 * targeted env vars (`CCLOOP_TUI_DEBUG=1`, etc.) are the right
 * lever, not a global "pretend this is a dev build" switch that
 * would re-expose unfinished commands.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;

const PROJECT_ROOT = dirname(import.meta.dir);

/** Pure predicate, exported for tests. */
export function isDevBuild(version: string, hasGit: boolean): boolean {
  return hasGit || version.includes("-");
}

export const IS_DEV_BUILD: boolean = isDevBuild(
  VERSION,
  existsSync(join(PROJECT_ROOT, ".git")),
);
