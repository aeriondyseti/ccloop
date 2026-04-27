export const SCHEMA_VERSION = 1;

export interface CcloopConfig {
  schema_version: number;
  loop: LoopConfig;
  claude: ClaudeConfig;
  failure: FailureConfig;
  notify: NotifyConfig;
  prompt: PromptConfig;
}

export interface LoopConfig {
  max_steps: number;
  max_wall_clock: string;
  target_cadence_seconds: number;
  pause_at_utilization: number;
  escalate_at_utilization: number;
  rate_limit_default_pause_seconds: number;
}

export interface ClaudeConfig {
  yolo_mode: boolean;
  max_turns_per_step: number;
  max_continuations_per_step: number;
  effort: string;
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
}

export interface PromptConfig {
  template_path: string;
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
  },
  claude: {
    yolo_mode: false,
    max_turns_per_step: 50,
    max_continuations_per_step: 5,
    effort: "xhigh",
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
  },
  prompt: {
    template_path: "",
  },
};

const KNOWN_KEYS: Record<string, ReadonlySet<string>> = {
  loop: new Set(Object.keys(DEFAULTS.loop)),
  claude: new Set(Object.keys(DEFAULTS.claude)),
  failure: new Set(Object.keys(DEFAULTS.failure)),
  notify: new Set(Object.keys(DEFAULTS.notify)),
  prompt: new Set(Object.keys(DEFAULTS.prompt)),
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
  return {
    schema_version: SCHEMA_VERSION,
    loop: mergeSection("loop", DEFAULTS.loop, r.loop),
    claude: mergeSection("claude", DEFAULTS.claude, r.claude),
    failure: mergeSection("failure", DEFAULTS.failure, r.failure),
    notify: mergeSection("notify", DEFAULTS.notify, r.notify),
    prompt: mergeSection("prompt", DEFAULTS.prompt, r.prompt),
  };
}
