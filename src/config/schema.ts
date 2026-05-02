import { parseWallClock } from "../loop/duration.ts";

export const SCHEMA_VERSION = 1;

export interface CcloopConfig {
  schema_version: number;
  loop: LoopConfig;
  claude: ClaudeConfig;
  failure: FailureConfig;
  notify: NotifyConfig;
  prompt: PromptConfig;
  design: DesignConfig;
}

export interface LoopConfig {
  max_steps: number;
  max_wall_clock: string;
  target_cadence_seconds: number;
  pause_at_utilization: number;
  escalate_at_utilization: number;
  rate_limit_default_pause_seconds: number;
  /** Shell command run after each successful step, before auto-commit.
   *  Non-zero exit → step is recorded as a `gate` failure and not
   *  committed; the failure excerpt is fed into the next prompt's
   *  `last_error` block. Empty string disables the gate. */
  gate_command: string;
  /** Per-invocation timeout for `gate_command`. A hung typecheck or
   *  test runner must not be able to stall the orchestrator overnight. */
  gate_timeout_seconds: number;
  /** Run each step inside a git worktree at `.ccloop/worktree/`,
   *  branched from HEAD onto `ccloop/<run_id>`. Isolates ccloop's
   *  commits from the user's working branch until the run finishes,
   *  then fast-forwards the user's branch onto the worktree's tip on
   *  success. Disable to commit straight onto the current branch
   *  (legacy behavior). */
  use_worktree: boolean;
}

export interface ClaudeConfig {
  yolo_mode: boolean;
  max_turns_per_step: number;
  max_continuations_per_step: number;
  effort: string;
  /** Cap how many consecutive steps reuse a single SDK session before
   *  ccloop forces a fresh one. 0 disables the cap (always resume).
   *  Default 30: overnight runs accumulate conversation history on
   *  resume, and at ~5KB per step the 200K context window fills in
   *  ~40 steps. A periodic reset bounds context growth and
   *  re-establishes a clean cache prefix; Claude re-reads SPEC.md /
   *  progress.md from disk on the first step of the new session. */
  max_steps_per_session: number;
  /** Proactive context-rotation watermark, expressed as a fraction
   *  of the model's context window (0–1). After each step, if the
   *  most recent step's input-side token count crosses this fraction
   *  of the window, ccloop drops the SDK session so the next step
   *  starts fresh — getting ahead of the reactive context_overflow
   *  rotation. Default 0.90 leaves a 10% buffer for the next turn's
   *  output and tool results. Set to 0 (or ≥1) to disable. */
  context_rotate_threshold: number;
  /** Optional text appended to Claude Code's default system prompt.
   *  Use for project-level guidance the model should always carry —
   *  tone, scope, "this is a research simulation, not malware"-type
   *  pre-emptions for safety scaffolding that pattern-matches on
   *  the project. Empty string leaves the default prompt untouched.
   *  Replaces, not augments, the harness when ccloop hands off to
   *  the SDK; the per-step task prompt is unaffected. */
  system_prompt: string;
  /** Specific Claude model to use. Empty string uses the SDK's
   *  current default. */
  model: string;
  /** Fallback model if the primary fails or is unavailable
   *  (Anthropic-side overload). Empty string disables the fallback. */
  fallback_model: string;
  /** Hard wall-clock cap on a single step's SDK call. If the SDK
   *  iterator stalls mid-stream (network read hangs at 90%) overnight
   *  there's no native watchdog — neither the SDK nor ccloop. This
   *  cap aborts the step via its abort controller, records a
   *  `step_timeout` failure, and lets the orchestrator route through
   *  normal backoff/escalation. 0 disables the watchdog. */
  step_timeout_seconds: number;
}

export interface FailureConfig {
  consecutive_failures_before_escalation: number;
  backoff: number[];
  loop_detection_repeats: number;
  no_progress_threshold: number;
}

export interface NotifyConfig {
  push_url: string;
  webhook_url: string;
  pause_alert_seconds: number;
  notify_on_done: boolean;
  /** Liveness URL pinged after every step (any outcome) and on done.
   *  Designed for healthchecks.io-style endpoints so an off-device
   *  monitor can alert when ccloop stops sending pings overnight.
   *  Best-effort POST with a small JSON body; failures are swallowed. */
  heartbeat_url: string;
}

export interface PromptConfig {
  template_path: string;
}

export interface DesignConfig {
  /** Model to use for design sessions (defaults to Claude Opus, independent of claude.model) */
  model: string;
  /** Maximum turns per SDK query call for design sessions (generous default for interactive work) */
  max_turns: number;
  /** Effort level (maps to maxThinkingTokens) */
  effort: string;
  /** Whether to show the TUI (can be disabled for non-TTY environments) */
  enable_tui: boolean;
}

export const DEFAULTS: CcloopConfig = {
  schema_version: SCHEMA_VERSION,
  loop: {
    max_steps: 200,
    max_wall_clock: "8h",
    target_cadence_seconds: 240,
    pause_at_utilization: 95.0,
    escalate_at_utilization: 80.0,
    rate_limit_default_pause_seconds: 3600,
    gate_command: "",
    gate_timeout_seconds: 300,
    use_worktree: true,
  },
  claude: {
    yolo_mode: false,
    max_turns_per_step: 50,
    max_continuations_per_step: 5,
    effort: "xhigh",
    max_steps_per_session: 30,
    context_rotate_threshold: 0.90,
    system_prompt: "",
    model: "",
    fallback_model: "",
    step_timeout_seconds: 1800,
  },
  failure: {
    consecutive_failures_before_escalation: 3,
    backoff: [30, 60, 120],
    loop_detection_repeats: 3,
    no_progress_threshold: 5,
  },
  notify: {
    push_url: "",
    webhook_url: "",
    pause_alert_seconds: 1800,
    notify_on_done: false,
    heartbeat_url: "",
  },
  prompt: {
    template_path: "",
  },
  design: {
    model: "claude-opus-4-20250514",
    max_turns: 100,
    effort: "high",
    enable_tui: true,
  },
};

const KNOWN_KEYS: Record<string, ReadonlySet<string>> = {
  loop: new Set(Object.keys(DEFAULTS.loop)),
  claude: new Set(Object.keys(DEFAULTS.claude)),
  failure: new Set(Object.keys(DEFAULTS.failure)),
  notify: new Set(Object.keys(DEFAULTS.notify)),
  prompt: new Set(Object.keys(DEFAULTS.prompt)),
  design: new Set(Object.keys(DEFAULTS.design)),
};

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  ...Object.keys(KNOWN_KEYS),
]);

export class ConfigError extends Error {}

function expectType(
  path: string,
  value: unknown,
  expected: "string" | "number" | "boolean" | "array",
): void {
  const actual = Array.isArray(value) ? "array" : typeof value;
  if (actual !== expected) {
    throw new ConfigError(
      `config: expected ${expected} at \`${path}\`, got ${actual}`,
    );
  }
}

function checkKnown(section: string, obj: Record<string, unknown>): void {
  const known = KNOWN_KEYS[section];
  if (!known) return;
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new ConfigError(`config: unknown key \`${section}.${key}\``);
    }
  }
}

function mergeSection<T>(
  section: string,
  defaults: T,
  override: unknown,
): T {
  if (override === undefined) return { ...(defaults as object) } as T;
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new ConfigError(`config: \`[${section}]\` must be a table`);
  }
  const o = override as Record<string, unknown>;
  checkKnown(section, o);
  const merged: Record<string, unknown> = { ...(defaults as object) } as Record<string, unknown>;
  for (const [key, val] of Object.entries(o)) {
    const def = (defaults as Record<string, unknown>)[key];
    if (Array.isArray(def)) {
      expectType(`${section}.${key}`, val, "array");
    } else {
      expectType(`${section}.${key}`, val, typeof def as "string" | "number" | "boolean");
    }
    merged[key] = val;
  }
  return merged as T;
}

export function mergeConfig(raw: unknown): CcloopConfig {
  if (raw === undefined) return structuredClone(DEFAULTS);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config: top-level must be a TOML table");
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(`config: unknown key \`${key}\``);
    }
  }
  if (r.schema_version !== undefined) {
    if (typeof r.schema_version !== "number") {
      throw new ConfigError("config: `schema_version` must be a number");
    }
    if (r.schema_version > SCHEMA_VERSION) {
      throw new ConfigError(
        `config: schema_version ${r.schema_version} > supported ${SCHEMA_VERSION}; upgrade ccloop`,
      );
    }
  }
  const cfg: CcloopConfig = {
    schema_version: SCHEMA_VERSION,
    loop: mergeSection("loop", DEFAULTS.loop, r.loop),
    claude: mergeSection("claude", DEFAULTS.claude, r.claude),
    failure: mergeSection("failure", DEFAULTS.failure, r.failure),
    notify: mergeSection("notify", DEFAULTS.notify, r.notify),
    prompt: mergeSection("prompt", DEFAULTS.prompt, r.prompt),
    design: mergeSection("design", DEFAULTS.design, r.design),
  };
  validateRanges(cfg);
  return cfg;
}

/** Range checks for fields where an out-of-band value would produce
 *  a stuck or surprising run (the type system only enforces shape). */
function validateRanges(cfg: CcloopConfig): void {
  // Empty string disables the wall-clock guardrail; anything else
  // must parse. A typo'd value (e.g. "8 hours" without quotes around
  // a TOML reserved word) used to silently disable it overnight.
  if (cfg.loop.max_wall_clock !== "" && parseWallClock(cfg.loop.max_wall_clock) === null) {
    throw new ConfigError(
      `config: \`loop.max_wall_clock\` is not a parseable duration (got "${cfg.loop.max_wall_clock}"; ` +
      `try "8h", "30m", "1d 2h" — or "" to disable)`,
    );
  }
  if (cfg.claude.max_turns_per_step < 1) {
    throw new ConfigError(
      `config: \`claude.max_turns_per_step\` must be >= 1, got ${cfg.claude.max_turns_per_step}`,
    );
  }
  if (cfg.claude.max_steps_per_session < 0) {
    throw new ConfigError(
      `config: \`claude.max_steps_per_session\` must be >= 0 (0 disables), got ${cfg.claude.max_steps_per_session}`,
    );
  }
  if (cfg.claude.context_rotate_threshold < 0 || cfg.claude.context_rotate_threshold > 1) {
    throw new ConfigError(
      `config: \`claude.context_rotate_threshold\` must be in [0, 1] (0 disables), got ${cfg.claude.context_rotate_threshold}`,
    );
  }
  if (cfg.loop.max_steps < 0) {
    throw new ConfigError(
      `config: \`loop.max_steps\` must be >= 0 (0 disables), got ${cfg.loop.max_steps}`,
    );
  }
  if (cfg.loop.target_cadence_seconds < 0) {
    throw new ConfigError(
      `config: \`loop.target_cadence_seconds\` must be >= 0, got ${cfg.loop.target_cadence_seconds}`,
    );
  }
  for (const k of ["pause_at_utilization", "escalate_at_utilization"] as const) {
    const v = cfg.loop[k];
    if (v < 0 || v > 100) {
      throw new ConfigError(
        `config: \`loop.${k}\` must be in [0, 100], got ${v}`,
      );
    }
  }
  if (cfg.failure.consecutive_failures_before_escalation < 1) {
    throw new ConfigError(
      `config: \`failure.consecutive_failures_before_escalation\` must be >= 1, got ${cfg.failure.consecutive_failures_before_escalation}`,
    );
  }
  if (cfg.failure.no_progress_threshold < 1) {
    throw new ConfigError(
      `config: \`failure.no_progress_threshold\` must be >= 1, got ${cfg.failure.no_progress_threshold}`,
    );
  }
  if (cfg.failure.loop_detection_repeats < 2) {
    throw new ConfigError(
      `config: \`failure.loop_detection_repeats\` must be >= 2, got ${cfg.failure.loop_detection_repeats}`,
    );
  }
  if (cfg.claude.step_timeout_seconds < 0) {
    throw new ConfigError(
      `config: \`claude.step_timeout_seconds\` must be >= 0 (0 disables), got ${cfg.claude.step_timeout_seconds}`,
    );
  }
  if (cfg.loop.gate_timeout_seconds < 1) {
    throw new ConfigError(
      `config: \`loop.gate_timeout_seconds\` must be >= 1, got ${cfg.loop.gate_timeout_seconds}`,
    );
  }
  for (const [i, b] of cfg.failure.backoff.entries()) {
    if (typeof b !== "number" || b < 0) {
      throw new ConfigError(
        `config: \`failure.backoff[${i}]\` must be a non-negative number, got ${b}`,
      );
    }
  }
  if (cfg.design.max_turns < 1) {
    throw new ConfigError(
      `config: \`design.max_turns\` must be >= 1, got ${cfg.design.max_turns}`,
    );
  }
}
