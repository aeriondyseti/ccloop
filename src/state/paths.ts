import { join } from "node:path";

export const CCLOOP_DIR = ".ccloop";
export const SPEC_FILENAME = "SPEC.md";
export const DONE_FILENAME = "DONE.md";
export const CONFIG_FILENAME = "ccloop.toml";

export interface RuntimePaths {
  root: string;          // CCLOOP_DIR (absolute)
  state: string;         // state.json
  lock: string;          // ccloop.lock
  events: string;        // events.jsonl
  progress: string;      // progress.md
  steps: string;         // steps/
  promptOverride: string; // prompt.md (optional)
  worktree: string;       // worktree/ (when loop.use_worktree)
}

export function runtimePaths(cwd: string): RuntimePaths {
  const root = join(cwd, CCLOOP_DIR);
  return {
    root,
    state: join(root, "state.json"),
    lock: join(root, "ccloop.lock"),
    events: join(root, "events.jsonl"),
    progress: join(root, "progress.md"),
    steps: join(root, "steps"),
    promptOverride: join(root, "prompt.md"),
    worktree: join(root, "worktree"),
  };
}

export function stepRecordPath(paths: RuntimePaths, step: number): string {
  return join(paths.steps, `${String(step).padStart(4, "0")}.json`);
}
