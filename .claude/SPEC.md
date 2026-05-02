# ccloop — Build Contract

> Audience: a coding agent (you) building ccloop in this directory.
> Style: terse, contract-shaped. Not a tutorial.
>
> This spec is ephemeral. It exists to drive the MVP build. Once
> ccloop ships and works, this whole `.claude/` directory can be
> deleted.

---

## 0. Distribution & Install

**Package**: `ccloop`, published to npm.

**Install**:
```
bun install -g ccloop
```

**Runtime**: Bun ≥ 1.1. TypeScript source executed directly by Bun —
no build step, no transpile, no compiled JS in the published package.

**Binary**: installs a single executable, `ccloop`, on `$PATH`.

**Runtime dependencies (bundled)**:
- `@anthropic-ai/claude-agent-sdk` — primary Claude invocation path.
- `ink` + `react` — TUI rendering.
- `smol-toml` — config loading.
- `parse-duration` — duration string parsing.

**Runtime dependencies (external; ccloop errors clearly if missing)**:
- `git` — required.
- `bwrap` (bubblewrap) — required on Linux when `[claude].yolo_mode`
  is `false` (the default).
- `sandbox-exec` — used on macOS when `yolo_mode` is `false`. Built
  into macOS; no install needed. Officially deprecated by Apple but
  still functional and standard for this purpose.

**Required environment**:
- `CLAUDE_CODE_OAUTH_TOKEN` — generated via `claude setup-token`.
  ccloop refuses to start without it. `ANTHROPIC_API_KEY` is accepted
  as an alternative for direct-API users but is not the optimized path
  (see ROADMAP).

**`git` behavior on startup** (before any step runs):

- **CWD is empty** (no files or only `SPEC.md`/`ccloop.toml`): ccloop
  runs `git init`, makes an initial empty commit (`chore: ccloop
  init`), and proceeds.
- **CWD has `.git`**: proceeds normally.
- **CWD has files but no `.git`**: refuses with a clear error.
  Auto-initializing over existing files risks committing things the
  user didn't intend.

**State scope**: ccloop writes only to the current working directory.
All run state lives under `./.ccloop/`. There is no global config, no
`~/.ccloop/`. **Deleting `./.ccloop/` after a successful run leaves a
clean working project with no ccloop residue.** This is a hard design
rule; it shapes choices in §12 (no global config file) and §13b
(everything goes through `.ccloop/`).

**Auth**: ccloop does not handle Anthropic auth. It inherits whatever
auth the user's `claude` CLI / Agent SDK already has. If auth is
missing or expired, the SDK call fails and ccloop surfaces the error
verbatim.

**Read-only external paths**: ccloop reads `~/.claude/projects/` only
indirectly via the Agent SDK. It never writes there.

---

## 1. Goals & Non-Goals

### Goals

ccloop must:

1. Drive a single Claude Code session in a loop against a user-authored
   `SPEC.md` until that spec is satisfied, with no human input per
   step on the happy path.
2. Treat **done = `DONE.md` exists**. Single check, evaluated at
   invocation start and the start of every step. The spec's
   `## Verification Requirements` section defines what must be true
   *before* Claude creates `DONE.md`; ccloop trusts Claude's judgment
   per the agentic-self-verification premise.
3. Maintain prompt-cache warmth across steps. Surface the actual hit
   rate per step on the dashboard.
4. Survive usage-limit exhaustion gracefully (5h cap pauses; weekly
   cap escalates).
5. Be fully resumable. `ccloop run --continue` reads
   `./.ccloop/state.json` and picks up at the next step after a crash,
   kill, reboot, or pause.
6. Keep all state local and disposable under `./.ccloop/`.
7. Auto-commit every step on a clean working tree.
8. Escalate, don't spin, on real failures (push + webhook
   notification after N consecutive failures).
9. Run as a foreground process with a TUI dashboard.

### Non-Goals

ccloop is not:

- A general agent framework. One fixed loop shape against one spec.
- A multi-project tool. One ccloop instance, one directory.
- A planning tool. The user (or a separate process) writes SPEC.md;
  ccloop executes against it.
- A code-review tool. ccloop verifies via the spec's Verification
  Requirements (Claude-evaluated). It does not opine on code quality
  beyond what those requirements catch.
- A sandbox or permission system. ccloop inherits whatever permissions
  the user's Claude Code has. The MVP scopes Bash via `bwrap` /
  `sandbox-exec` when `yolo_mode: false`, but does not provide
  isolation beyond that.
- An auth manager. ccloop never prompts for, stores, or rotates
  Anthropic credentials.
- A GitHub / remote integration (parked in ROADMAP).
- A team or multi-user tool.
- A long-lived service. ccloop exits when the spec is done, when
  guardrails trip, or when killed.

---

## 2. Vocabulary

### 2.1 ccloop's units

**Run** — one end-to-end execution of ccloop against a single project
(one CWD, one `SPEC.md`, one `.ccloop/`). Lasts until a terminal
state: `done`, `escalated`, guardrail-trip, or abandonment. May span
multiple instances connected by `ccloop run --continue`.

**Instance** — one OS process lifetime: from `ccloop run` (or
`ccloop run --continue`) until the process exits. Multiple instances
compose one run.

**Step** — one cycle of ccloop's outer loop = one SDK `query` (or
`resume`) call. ccloop's loop counter is the step counter; "step 47"
is canonical phrasing. Each step ends with one `ResultMessage`. Steps
are the unit at which ccloop commits, persists state, and rolls up
telemetry.

**Turn** — one round trip *inside* a step, in Anthropic's sense:
Claude produces an assistant response (possibly with tool calls), the
SDK runs the tools locally, and the results feed back. The SDK's
`maxTurns` option bounds turns per step. ccloop never commits or logs
per-turn; turns are an internal detail of the SDK exposed only as
telemetry.

### 2.2 Project artifacts

**Spec** — the target project's `./SPEC.md`. When this document says
"the spec," it means the target's. ccloop's own spec lives at
`.claude/SPEC.md` and is referred to by path.

**Verification Requirements** — the `## Verification Requirements`
section of the spec. The user-authored conditions Claude must satisfy
before creating `DONE.md`.

**Checklist** — the `- [ ]` / `- [x]` lines in the spec. Informational,
surfaced on the dashboard, not a done gate.

**`DONE.md`** — the sentinel file at the project root whose presence
is the run's terminal "done" condition. ccloop never creates or
deletes it.

### 2.3 ccloop runtime artifacts (under `./.ccloop/`)

**Progress scratchpad** — `./.ccloop/progress.md`. Cross-step memory
channel. Claude appends to it during a step; ccloop appends a brief
footer after each step.

**State file** — `./.ccloop/state.json`. Source of truth for
`--continue`. Holds run id, current step number, last session id,
pause state, escalation state, failure counter.

**Event log** — `./.ccloop/events.jsonl`. Append-only structured log
of step lifecycle, errors, pauses, commits, notifications. Drives the
dashboard's events panel and any post-mortem.

**Step record** — `./.ccloop/steps/NNNN.json`. One per step: telemetry
(tokens, cache, cost, duration, num_turns), `stop_reason`, `subtype`,
commit sha, outcome.

**Lock** — `./.ccloop/ccloop.lock`. Held by the active instance;
prevents two instances against the same directory.

### 2.4 Other terms

**Session** — a Claude Agent SDK session, identified by `session_id`.
ccloop holds one in-memory SDK client per instance. The session id is
persisted to `state.json` so subsequent instances can `resume`.

**Cadence** — time between step starts.

**Cache window** — the prompt-cache TTL (5m default; 1h with
`ENABLE_PROMPT_CACHING_1H=1`, which ccloop sets).

**Cache hit rate** — `cache_read_input_tokens / (cache_read_input_tokens
+ cache_creation_input_tokens + input_tokens)` per step, summed across
all turns within the step. Cache creation counts as a miss: those tokens
were processed fresh and written to the cache for later reads.

**Usage window** — Anthropic's rolling rate-limit windows (5h and
weekly). Distinct from cache window.

**Pause** — instance state when 5h usage is exhausted. Sleeps until
the parsed reset time, then re-enters the active step's pre-flight.

**Escalation** — terminal state after N consecutive step failures, or
on weekly-cap exhaustion. Notifications fire on entry; the run halts
awaiting human input via TUI.

**Guardrail** — a hard bound on a run: `max_steps`, `max_wall_clock`,
dirty-tree refusal.

**Inference** — colloquial for "one HTTP call to the model."
Effectively 1:1 with Anthropic's "turn" since each turn has exactly
one assistant response. ccloop does not surface inferences as a unit.

### 2.5 Anthropic terminology footnote

Anthropic docs and the Agent SDK use **"turn"** consistently for the
inner round-trip cycle (one assistant response + tool execution). The
SDK's `maxTurns` parameter caps these. ccloop's "turn" matches
Anthropic's exactly.

The thing Anthropic calls **"the agent loop"** (one full `query()`
execution that ends with a `ResultMessage`) is what ccloop calls a
**"step."** "Loop" is reserved for prose use only — never a unit.

---

## 3. Inputs

All inputs are read from the user's CWD or paths relative to it.
ccloop reads from the install location only for the embedded default
prompt template.

### 3.1 SPEC.md — required

Path: `./SPEC.md`. Plain Markdown.

**Required structural elements**:

- ≥ 1 checklist item: a line matching `^- \[[ x]\] ` somewhere in
  the file.
- A `## Verification Requirements` heading whose body is non-empty.
  Body is prose Claude reads; ccloop does not parse it. The default
  template ships with:
  ```
  1. All SPEC.md checkboxes complete.
  2. All tests pass.
  3. Code has at least 75% branch coverage.
  ```

**Validation, run at startup**:

| Check | Failure mode |
|---|---|
| File exists | Error: missing SPEC.md, point at `templates/SPEC.md`. |
| ≥ 1 `- [ ]` or `- [x]` line | Error: "SPEC.md has no checklist." |
| `## Verification Requirements` heading present | Error. |
| `## Verification Requirements` body non-empty | Error. |

ccloop validates SPEC.md once per instance, at startup. Mid-run edits
are picked up on the next step's prompt assembly but are not
re-validated.

### 3.2 ccloop.toml — optional

Path: `./ccloop.toml`. Absent ⇒ defaults apply. Schema in §12.

**Unknown keys are an error, not a warning.** ccloop refuses to start
on unknown keys and prints the offending key path.

### 3.3 CLI flags

Pinned in §12. Precedence: **flag > `ccloop.toml` > built-in default**.

### 3.4 Environment variables

- **Inherited (read, never set)**: `CLAUDE_CODE_OAUTH_TOKEN` (required),
  `ANTHROPIC_API_KEY` (alternative), anything else the SDK reads.
- **Set by ccloop before invoking the SDK**:
  - `ENABLE_PROMPT_CACHING_1H=1` — opt into 1-hour cache TTL (§7).
- **Read by ccloop itself**:
  - `CCLOOP_LOG_LEVEL` — `debug` | `info` | `warn` | `error`. Default
    `info`.
  - `NO_COLOR` — standard; disables ANSI colors.

ccloop does **not** define environment variables for things that have
a config-file equivalent. One source of truth per setting.

### 3.5 Prompt template

Default ships embedded in the binary. User override via
`[prompt].template_path` in `ccloop.toml`, conventionally
`./.ccloop/prompt.md`.

Per-step substitutions:

- `{{spec}}` — full SPEC.md (read fresh each step).
- `{{progress}}` — full `./.ccloop/progress.md` (read fresh each step).
- `{{last_error}}` — text of the previous step's error if it failed;
  empty otherwise.
- `{{step}}` — current step number.

Mustache-style, no logic, no partials. Substitutions are raw text (no
HTML escaping).

### 3.6 What is NOT an input

- No `SPEC.md` discovery. Path is fixed at `./SPEC.md`.
- No multi-file specs. Linking out is fine; ccloop doesn't follow.
- No `.env` loading.
- No verify command. Per Goal #2, verification lives in the spec's
  `## Verification Requirements` section, not as a separate ccloop
  input.

---

## 4. Step Loop

The loop is a deterministic state machine. Every step follows the
same sequence; the only branching is on post-conditions.

### 4.1 States

```
                   ┌─────────────┐
   ccloop run ────►│   STARTING  │
                   └──────┬──────┘
                          │ validate, lock, open SDK
                          ▼
                   ┌─────────────┐  DONE.md present
              ┌───►│   RUNNING   ├────────────────►  DONE
              │    └──┬───────┬──┘
       resume │       │ usage │ N consecutive failures
              │       │ cap   │ or weekly cap
              │       ▼       ▼
              │    ┌──────┐ ┌────────────┐
              └────┤PAUSED│ │ ESCALATED  ├── notify, await human
                   └──────┘ └────────────┘
```

Terminal states: `DONE`, `ESCALATED`, guardrail-trip, fatal error.

### 4.2 Step contract

Each step N executes the following in order. Any step's failure routes
to §9 with the step name as the failure category.

**Pre-flight**:

1. Check terminal: if `./DONE.md` exists, exit `RUNNING` → `DONE`.
2. Check guardrails: step cap, wall-clock cap. Any breach ⇒ exit with
   guardrail-trip.
3. Check usage via `/api/oauth/usage` (§7.6): five_hour ≥
   `pause_at_utilization` ⇒ enter `PAUSED` (§8). seven_day ≥
   `escalate_at_utilization` ⇒ enter `ESCALATED`.
4. Open / resume session: on the first step of an instance, start a
   new SDK session and persist its session id. Otherwise reuse the
   in-memory client.

**Execute**:

5. Assemble prompt: render `{{spec}}`, `{{progress}}`, `{{last_error}}`,
   `{{step}}` into the active template.
6. Invoke Claude: send the rendered prompt as one `query` (or
   `resume`). Stream events to the TUI. The step ends when the
   iterator drains after a terminal `ResultMessage` (§6.3).
7. Capture telemetry: read `total_cost_usd`, `usage`, `num_turns`,
   `stop_reason`, `subtype` from the `ResultMessage`. Sum cache stats
   across turns from per-message usage in the JSONL session file.

**Post-flight**:

7a. Optional gate (`loop.gate_command`, default empty): if configured
    and the step is otherwise a success, run the command via `sh -c`
    in the project group, bounded by `loop.gate_timeout_seconds`
    (default 300). Non-zero exit or timeout ⇒ record the step as a
    `gate` failure (§9.1) with the captured stdout/stderr tail as the
    excerpt; skip the auto-commit; route through §9.2. Zero exit ⇒
    proceed to step 8.
8. Auto-commit: `git add -A && git commit -m "<auto>"` with a message
   derived from the final assistant text (sanitized; capped). On
   unchanged tree, skip and record `no-op` in the step record.
9. Write step record: `./.ccloop/steps/NNNN.json`.
10. Append to event log: `./.ccloop/events.jsonl`.
11. Update progress scratchpad: append a short ccloop-authored footer
    (step #, commit sha, one-line summary). Claude's own writes to
    `progress.md` during the step are preserved.
12. Persist `state.json` atomically.

**Decide next**:

13. On step failure: increment failure counter; if ≥
    `consecutive_failures_before_escalation`, enter `ESCALATED`;
    otherwise sleep `backoff[failure_count]` seconds.
14. On step success: reset failure counter.
15. Check terminal again: if `./DONE.md` exists, exit `RUNNING` →
    `DONE`.
16. Cadence sleep: `target_cadence_seconds − step_duration`. If
    positive, sleep; if negative, start immediately. State is durable
    before the sleep begins.
17. Increment N; return to step 1.

### 4.3 Guarantees

- **Atomicity per step**: the working tree is either unchanged from
  pre-step state (on failure before commit) or fully committed by
  post-flight end. ccloop never crosses a step boundary on the happy
  path with a dirty tree.
- **Step numbering is monotonic** within a run, persisted in
  `state.json`, and survives `--continue`.
- **One SDK query per step.** The SDK may run many turns; that is one
  step regardless.
- **State durable before any sleep.** Cadence sleep, backoff sleep,
  and pause sleep all happen *after* `state.json` is persisted.

### 4.4 Non-step work

- Validation runs once at instance start (§3), never per step.
- Notifications fire on entry to `ESCALATED` and on extended `PAUSED`,
  not per step.
- TUI rendering runs continuously on its own tick; step phases publish
  events to a queue the TUI consumes. The step loop never blocks on
  the TUI.

---

## 5. Done Detection

### 5.1 Rule

Done iff `./DONE.md` exists at the target-project root.

This is the only check. ccloop does not parse `DONE.md`, does not
validate its content. Its mere presence as a regular file is the
signal.

### 5.2 When the check fires

| Site | Behavior on `DONE.md` present |
|---|---|
| Invocation start, before any step | Exit immediately with status `done`. Print "project already complete." Skip setup beyond validation. |
| Start of every step (§4 step 1) | Exit the loop with status `done`. Run shutdown (write final `state.json`, flush event log, render terminal TUI screen). |

Both sites use `fs.existsSync("./DONE.md")`.

### 5.3 What ccloop does NOT do

- Does not delete `DONE.md`. Presence is terminal.
- Does not validate `DONE.md` against the spec.
- Does not check checklist completion as a done condition.
- Does not create `DONE.md` itself, ever.

### 5.4 User overrides

- **Force-stop a run cleanly**: user creates `DONE.md` manually.
- **Re-open a "done" project**: user deletes `DONE.md`, runs ccloop.
- **Permanently retire**: user leaves `DONE.md` and deletes
  `./.ccloop/`.

---

## 6. Claude Invocation

### 6.1 Path

ccloop invokes Claude exclusively via
`@anthropic-ai/claude-agent-sdk` (TypeScript). Headless `claude -p` is
not part of MVP; parked for daemon/remote modes in `ROADMAP.md`.

### 6.2 Session lifecycle

- **One in-process SDK client per instance.** Held across all steps;
  closed only on shutdown.
- **Session id is persisted** to `./.ccloop/state.json` after the
  first successful step. `ccloop run --continue` reads the id and
  calls the SDK's `resume`. If unresumable (Anthropic-side expiry,
  missing JSONL), ccloop logs a warning, opens a fresh session, and
  continues — the filesystem-as-memory model treats this as a slowdown
  (cold cache), not a correctness failure.
- **One `query`/`resume` call per step.** ccloop drains the iterator
  to completion before deciding next.

### 6.3 Step-end signal

The step ends when the async iterator drains *after* receiving a
terminal `ResultMessage`. ccloop reacts to `subtype` and `stop_reason`:

| `subtype` | `stop_reason` | Meaning | Action |
|---|---|---|---|
| `success` | `end_turn` | Normal completion | Proceed to post-flight. |
| `success` | `max_tokens` | Final response hit output cap; agent loop ended | Proceed; record on step. |
| `success` | `pause_turn` | Server tool loop hit its own iter cap | Auto-continue *within the same step* with empty continuation prompt; bounded by `[claude].max_continuations_per_step` (default 5). |
| `success` | `refusal` | Model declined | Step failure (§9), category `refusal`. |
| `error_max_turns` | — | SDK's `maxTurns` cap hit | Step failure, category `max_turns`. |
| `error_during_execution` | — | Generic SDK execution error | Step failure, category `sdk`. |
| `error_max_structured_output_retries` | — | Structured-output retries exhausted | Step failure, category `structured_output`. |

Trailing system events (e.g. `prompt_suggestion`) may arrive after
`ResultMessage`; ccloop iterates to exhaustion before treating the
step as ended.

### 6.4 SDK options ccloop sets

| Option | Value | Why |
|---|---|---|
| `includePartialMessages` | `true` | Drives live TUI from streamed events. |
| `maxTurns` | from `[claude].max_turns_per_step` (default `50`) | Anthropic's `maxTurns` — bounds Anthropic-turns per step (= inferences in ccloop's vocabulary; see §2.5). |
| `permissionMode` | derived from `[claude].yolo_mode`: `false` → `"default"`, `true` → `"bypassPermissions"` | See §6.5. |
| `cwd` | target project root | Scopes tool calls to the project. |
| `settingSources` | `["project"]` | Loads the project's `CLAUDE.md` / hooks if present. |
| `effort` | from `[claude].effort` (default `"xhigh"`) | Highest-quality reasoning per step (Opus 4.7 recommendation). |
| `hooks.PreToolUse` | ccloop's sandbox-aware approver (see §6.5) | Pre-empts the CLI's hardcoded permission gates so the approver is the only trust boundary. |
| `resume` / `continue` | from `state.json` if present | See §6.2. |

`allowedTools` is **not** set. Users wanting tool restrictions
configure them in their `~/.claude/` settings.

### 6.5 Sandbox / permission policy

`yolo_mode` is the single user-facing knob.

**Why hooks, not `canUseTool`.** The Claude Agent SDK is a wrapper
around the `claude` CLI binary; the binary owns the permission system
and applies several hardcoded pre-checks before invoking
`canUseTool`:

- A Bash command-prefix allowlist (only common commands like `ls`,
  `cat`, `grep` auto-pass; `bun init`, `mkdir`, `chmod`, etc. require
  approval).
- A shell-operator gate (any command containing `>`, `<<`, `&&`, `|`,
  `||` requires approval).
- A file-write permission gate (Edit / Write to any path without a
  matching `permissions.allow` rule requires approval).

In an SDK context with no UI, "requires approval" comes back as a
tool error *without* ever invoking `canUseTool` — so a `canUseTool`
approver could not actually intercept those calls or wrap them in a
sandbox. **`hooks.PreToolUse`**, by contrast, runs *before* the
binary's permission system and can return an explicit
`permissionDecision` that overrides every pre-check. ccloop therefore
hangs its sandbox + denylist on a `PreToolUse` hook.

- **`yolo_mode: false`** (default):
  - `permissionMode: "default"`.
  - `hooks.PreToolUse` runs before the CLI's permission system. The
    hook returns one of `{ permissionDecision: 'allow' | 'deny',
    permissionDecisionReason?, updatedInput? }`.
  - Bash invocations are denylist-checked first; on match, the hook
    returns `deny` with the reason. The denylist covers catastrophic
    local patterns (`rm -rf /`, `:(){:|:&};:`, `sudo`, `dd of=/dev/`,
    etc.) and unambiguously destructive remote-mutation patterns
    (`git push --force` / `-f` / `--force-with-lease`, `git push
    <remote> +ref` shorthand, and `npm`/`yarn`/`pnpm`/`bun publish`).
    Network is otherwise unrestricted, so the denylist is the only
    guard against an overnight run rewriting a remote branch or
    publishing a package while the operator is away. Denials surface
    as tool errors so Claude can course-correct.
  - Bash invocations are otherwise allowed with `updatedInput.command`
    rewritten to wrap the original command via `bwrap` (Linux) or
    `sandbox-exec` (macOS). Both platforms apply the same shape:
    *reads are unrestricted across the host filesystem; writes are
    scoped to CWD and `/tmp`.* On Linux, bwrap ro-binds `/` and then
    layers a writable tmpfs on `/tmp` and a RW bind on CWD on top.
    On macOS, sandbox-exec uses `(allow default) (deny file-write*)`
    plus a write-allowlist for CWD and `/tmp`. This shape lets
    user-installed toolchains anywhere on disk (mise, asdf, nvm,
    `~/.bun`, `~/.cargo`, Homebrew, `/opt/...`) resolve inside the
    sandbox without enumeration. Network access is **not** restricted
    — package installers (`bun install`, `npm install`, `go mod
    download`, `pip install`, etc.) need internet; the boundary is
    filesystem scope, not exfiltration. Note: tools that write caches
    under `$HOME` (e.g. `~/.npm`, `~/.bun/install/cache`) will see
    EROFS and should be pointed at a writable location via
    tool-specific env vars, or run under `yolo_mode = true`.
  - Edit / Write / NotebookEdit / MultiEdit are allowed unchanged —
    the SDK's `cwd` already scopes file ops to the project root.
  - Per-Bash sandbox setup is fast (no VM), measurable in
    milliseconds.

- **`yolo_mode: true`**:
  - `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`.
  - The hook still runs but returns `allow` for every tool call with
    no rewriting; no sandboxing.
  - ccloop logs a warning on every instance start when `yolo_mode` is
    on.

**Sandbox failure modes**:

- A sandbox-blocked tool call returns to Claude as a tool error with a
  descriptive message (e.g. "command refers to path outside CWD").
  This is **not** a step failure (§9.1) — Claude course-corrects.
- If `bwrap` is unavailable on Linux while `yolo_mode: false`, the
  hook denies the call with a clear reason; the agent surfaces it,
  the user installs `bwrap` (or sets `yolo_mode = true`).

### 6.6 Environment

ccloop sets in the SDK's environment:

- `ENABLE_PROMPT_CACHING_1H=1` — opt into 1-hour cache TTL (§7).

Inherited (read, never set): `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, anything else the SDK reads.

### 6.7 Prompt assembly

Each step assembles the prompt by rendering the active template (§3.5)
with the four substitutions. Mustache-style, no logic, raw-text
substitution.

### 6.8 Default prompt template

Shipped embedded:

```markdown
You are working in a loop driven by ccloop. Keep making progress on
this project until every Verification Requirement in SPEC.md is
satisfied, and only then create DONE.md.

# Spec

{{spec}}

# Progress so far

{{progress}}

{{last_error}}

# Your task this step (#{{step}})

1. Read the spec, paying special attention to the
   `## Verification Requirements` section.
2. Pick the most useful next step toward satisfying those requirements.
   Smaller, verifiable changes are better than ambitious ones.
3. Make the change. Run whatever checks the spec implies (tests,
   linters, etc.) so you have evidence the change is good.
4. Update `./.ccloop/progress.md` with a short note about what you
   did and what you learned. Append; do not rewrite.
5. If — and only if — every Verification Requirement is now
   satisfied, create `./DONE.md` at the project root with a brief
   paragraph for each requirement explaining how it's met. Do not
   create `DONE.md` speculatively.

ccloop will commit your work after this step ends. Don't run
`git commit` yourself.
```

The user can replace the template via `[prompt].template_path`. No
partial overrides.

### 6.9 What ccloop does NOT send Claude per step

- No prior messages — the SDK's session restoration handles continuity.
- No automatic last-step summary — `progress.md` is the channel.
- No diff of last commit — same.

### 6.10 Cancellation

On SIGINT or SIGTERM:

1. ccloop calls `query.interrupt()` on the active client.
2. Waits up to 5s for the iterator to drain.
3. Persists `state.json` with current step marked `cancelled`.
4. Closes the client, flushes the event log, releases the lock, exits
   130 (SIGINT) or 143 (SIGTERM).

A SIGKILL leaves `state.json` at its last durable checkpoint;
`--continue` may rewind one step.

### 6.11 Invocation failure

If the SDK throws synchronously on `query` (auth missing, SDK
misconfigured, network unreachable on first contact), ccloop fails the
step per §9 with category `sdk_init` and applies standard
retry/backoff. Three consecutive `sdk_init` failures escalate.

---

## 7. Cache & Cadence

### 7.1 Cache strategy

ccloop opts into the **1-hour prompt-cache TTL** by setting
`ENABLE_PROMPT_CACHING_1H=1` in the SDK's environment (§6.6).

Rationale: the default 5-minute TTL is too tight for steps with long
tool calls. The 1h TTL costs ~2× to write but ~0.1× to read. For
long-running loops, total cost goes down.

Session resume across instances **invalidates the prompt cache**
(known SDK behavior). The first step of any new instance pays a cold
cache cost; ccloop surfaces this on the dashboard as a one-time
"instance cold start" event.

ccloop does not set explicit `cache_control` breakpoints. The Agent
SDK auto-applies caching to the system prompt, tool definitions, and
conversation history.

### 7.2 What stays cacheable across steps

Stable: system prompt, tool definitions, project `CLAUDE.md`, prior
turn history (until compaction).

Variable: rendered prompt template — spec rarely changes; `progress.md`
grows monotonically (prefix is cacheable; only the appended tail
breaks the cache).

### 7.3 Cadence target

Default: `target_cadence_seconds = 240` (4 minutes between step
starts).

Rationale at MVP: with 1h cache TTL, cache warmth is not the binding
constraint. 4-min cadence is a conservative throttle on toolchain
churn (test runs, builds shouldn't pile up faster than a fresh test
cycle takes) and gives the user a human-readable pace on the
dashboard.

If a step's own duration exceeds 240s, the cadence sleep is zero —
the loop runs as fast as the steps themselves do.

Cadence sleep happens *after* `state.json` is durable (§4 step 16).

### 7.4 Per-step telemetry (from the SDK)

ccloop reads from each step's `ResultMessage`:

| Field | Source |
|---|---|
| `total_cost_usd` | `ResultMessage.total_cost_usd` |
| `input_tokens`, `output_tokens` | `ResultMessage.usage` |
| `cache_read_input_tokens`, `cache_creation_input_tokens` | per-message usage in the JSONL session file (the SDK's `ResultMessage.usage` does not carry these in current versions; see §14) |
| `num_turns` | `ResultMessage.num_turns` |
| `stop_reason`, `subtype` | `ResultMessage` direct fields |
| step duration | wall-clock from invoke start to iterator drain |

Persisted to `./.ccloop/steps/NNNN.json`.

### 7.5 Cache hit rate

```
hit_rate = cache_read_input_tokens
         / (cache_read_input_tokens
            + cache_creation_input_tokens
            + input_tokens)
```

Cache creation is treated as a miss: those tokens were billed as fresh
input and written to the cache for *future* reads, not served from it.
Excluding them inflates the rate to ~100% any time the system prompt
is cached and the new user turn is small.

Surfaced on the dashboard per step and as a rolling average for the
run. ccloop logs a warning when hit rate drops below 50% three steps
in a row but takes no automatic action; investigation is by hand.

### 7.6 Window-level usage telemetry

The SDK does not expose Anthropic's rolling 5h or weekly window
status. ccloop fetches it from Anthropic's OAuth usage endpoint:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer ${CLAUDE_CODE_OAUTH_TOKEN}
anthropic-beta: oauth-2025-04-20
```

Response includes `five_hour.utilization` (0-100), `five_hour.resets_at`
(ISO), and the same fields for `seven_day`. ccloop caches the result
in memory for 180 seconds (matching the ccstatusline convention) and
refreshes the cache on each pre-flight check (§4 step 3) and each TUI
tick (§11).

**Endpoint is undocumented** — schema validator rejects malformed
responses gracefully; ccloop falls back to reactive-only detection
(§8). See §14 KU.

Failure modes:

- 429 (broken endpoint, known case for some Max subscribers — see
  anthropics/claude-code#30930, #31021): keep last good cache; proceed;
  reactive-only as safety net.
- 403: token is valid but lacks the `user:profile` scope this
  endpoint requires. `claude setup-token` issues `user:inference`
  only; the full `claude /login` OAuth flow grants `user:profile`.
  ccloop emits a one-time `usage_degraded` event explaining this and
  falls back to reactive-only — the proactive gate is advisory, so
  halting the run over a missing scope is wrong.
- 401: token genuinely invalid. Surface as a token-rotation prompt;
  pause indefinitely until resolved (escalation event).
- Shape mismatch / network error: emit `usage_degraded`; fall back
  to reactive-only.

### 7.7 What the dashboard surfaces

(Layout in §11; content here.)

- Per-step: tokens in/out, cost, cache hit rate.
- Run rolling: total cost, total tokens, cumulative duration, average
  cache hit rate.
- Window: 5h and weekly usage bars with reset countdowns.
- Cadence: time until next step start.

### 7.8 What ccloop does NOT do

- No cache "warming" pings. Pause means we genuinely don't talk to
  Anthropic until next real work.
- No user-side cache control in `ccloop.toml`. The env var is the
  only lever; the user can unset it externally if they really want
  to.
- No automatic context compaction. The SDK auto-compacts; ccloop
  observes the `compact_boundary` event for telemetry but does not
  trigger compaction.

---

## 8. Usage-Limit Handling

### 8.1 Goals

- Avoid wasted work (don't issue an SDK call we know will be
  rate-limited).
- Survive surprises (recover when proactive misses).
- Wake at the right time (within 30s of `resets_at`).
- Pause is invisible to Claude — no fake messages keep the session
  alive; ccloop simply doesn't issue the next step's `query`.

### 8.2 Two detection paths

| Path | Source | Authority | Latency |
|---|---|---|---|
| **Proactive** | `/api/oauth/usage` per §7.6 | Authoritative when working; subject to known endpoint outages | Pre-flight (every step) + TUI poll (every 30s) |
| **Reactive** | SDK error from `query` / `resume` | Definitive | Detected only on attempt |

### 8.3 Proactive detection

In §4 step 3, before opening the SDK:

```
if five_hour.utilization >= pause_at_utilization:
    pause_until = parse_iso(five_hour.resets_at) + 30s buffer
    enter PAUSED(reason: "five_hour cap at {utilization}%")

if seven_day.utilization >= escalate_at_utilization:
    enter ESCALATED(reason: "weekly_cap")
    fire notification
    terminate run
```

The 30s buffer accounts for clock skew and the endpoint's 180s cache.

Defaults: `pause_at_utilization = 95.0`, `escalate_at_utilization = 80.0`.

### 8.4 Reactive detection

When `query` / `resume` errors with a rate-limit signal:

```
if error text mentions "weekly" / "seven day" / weekly indicator:
    enter ESCALATED(reason: "weekly_cap (reactive)")
elif error text mentions "session" / "5h" / "five hour":
    parse reset time → enter PAUSED
else:
    parse reset time if present
    if reset > now + 12h → ESCALATED (treated as weekly)
    else → PAUSED
```

If no reset is parseable, default sleep is
`rate_limit_default_pause_seconds` (default 3600).

The 12h heuristic is the tiebreaker for ambiguous error text.

Reactive rate-limit detection is **not** a step failure (§9.1). The
failure counter is untouched.

### 8.5 PAUSED state machine

```
RUNNING ──(proactive trigger)──► PAUSED
        ──(reactive trigger)───► PAUSED

PAUSED:
  - render TUI paused screen with countdown
  - persist state.json (pause_until, pause_reason, pause_entered_at)
  - register sleep timer until pause_until
  - every 60s: refresh /api/oauth/usage; if window cleared early,
    wake immediately
  - if pause exceeds [notify].pause_alert_seconds (default 1800):
    fire notification once
  - on wake (timer or early-clear):
      - clear pause fields in state.json
      - re-enter pre-flight (step number unchanged)
      - RUNNING
  - on SIGINT/SIGTERM during pause:
      - persist state.json with pause_until preserved; exit cleanly
      - --continue resumes the pause from the same point
```

### 8.6 `--continue` during a pause

If killed during PAUSED and the user `--continue`s:

- `pause_until > now`: re-enter PAUSED with remaining time.
- `pause_until ≤ now`: skip pause; go straight to pre-flight.

Step number does not advance during pause.

### 8.7 What ccloop does NOT do during PAUSED

- No keepalive pings.
- No partial work (linters, builds during pause).
- No automatic budget downgrade.

### 8.8 Failure modes

| Scenario | Behavior |
|---|---|
| `/api/oauth/usage` says five_hour ≥ threshold | PAUSED until reset. |
| `/api/oauth/usage` says seven_day ≥ threshold | ESCALATED. Terminal. |
| Endpoint 429 (broken) | Use last good cache or proceed; reactive is safety net. |
| Auth error from endpoint | ESCALATED with reason `auth_invalid`. |
| SDK reactive error, parsed as 5h | PAUSED. |
| SDK reactive error, parsed as weekly | ESCALATED. |
| SDK reactive error, ambiguous, reset > 12h | ESCALATED. |
| SDK reactive error, ambiguous, reset ≤ 12h | PAUSED. |
| Both windows above threshold | seven_day wins → ESCALATED. |
| `extra_usage` (overage credits) rising | Surface as warning; do not pause or escalate. |

---

## 9. Failure Handling & Escalation

### 9.1 What counts as a step failure

| Category | Trigger |
|---|---|
| `sdk_init` | SDK throws synchronously on `query` / `resume` |
| `sdk` | `subtype: "error_during_execution"` |
| `max_turns` | `subtype: "error_max_turns"` |
| `structured_output` | `subtype: "error_max_structured_output_retries"` |
| `refusal` | `subtype: "success"` + `stop_reason: "refusal"` |
| `commit` | `git commit` errored after work was done |
| `gate` | `loop.gate_command` (if configured) exited non-zero or timed out |
| `step_timeout` | step exceeded `claude.step_timeout_seconds` watchdog |
| `loop_detected` | §9.4 heuristic |

What is **not** a failure:

- Rate-limit errors → PAUSED (§8). Failure counter untouched.
- Tool denials by the sandbox → normal; Claude reads denial and
  course-corrects.
- "Tests Claude wrote that don't pass yet" → normal; ccloop has no
  notion of "tests passed" outside the spec's Verification
  Requirements.
- `stop_reason: "max_tokens"` with `subtype: "success"` → step
  succeeded.

### 9.2 Retry policy

On step failure:

1. Persist failure to `./.ccloop/steps/NNNN.json` and `events.jsonl`
   with category and short error excerpt (sanitized; capped 1KB).
2. Increment consecutive-failure counter in `state.json`.
3. If counter ≥ `consecutive_failures_before_escalation` (default 3):
   enter ESCALATED.
4. Otherwise: sleep `backoff[counter - 1]` seconds (default
   `[30, 60, 120]`), then start step N+1.

The next step is a new step (number advances). Re-renders the prompt
with `{{last_error}}` populated.

### 9.3 Failure counter semantics

- Resets on any successful step.
- Persisted to `state.json`; survives `--continue`.
- Per-category sub-counters not tracked in MVP.

### 9.4 Loop detection

For each successful step, hash the git diff (`git diff HEAD~1 HEAD`,
normalized for whitespace). If `loop_detection_repeats` (default 3)
consecutive successful steps produce the same diff hash, the current
step is reclassified as `loop_detected` and contributes to the
failure counter.

Empty/no-op steps don't count toward this — handled separately
(§9.5).

### 9.5 No-progress detection

If `no_progress_threshold` (default 5) consecutive steps produce a
no-op commit (working tree unchanged), ccloop escalates with reason
`no_progress`.

Distinct from `loop_detected`: no-progress is "Claude isn't doing
anything"; loop-detected is "Claude is doing the same thing."

### 9.6 Escalation

Entering ESCALATED:

1. Persist `state.json` with `state: "escalated"` and reason.
2. Fire notifications (push + webhook) per `[notify]`. Body includes
   project path, current step, escalation reason, recent failure
   trail (last 3 step records).
3. Render the escalated TUI screen with single-key controls.
4. Stop running new steps. Instance stays alive, awaiting human input.

Single-key controls in the escalated screen:

| Key | Action |
|---|---|
| `c` | Continue: reset failure counter; transition to RUNNING starting at step N+1. |
| `r` | Revert: `git reset --hard <last-green-sha>`, then continue. "Last green" = most recent successful, non-no-op step. |
| `e` | Edit and pause: opens `$EDITOR` on `SPEC.md`; on save, transitions to RUNNING. |
| `q` | Quit cleanly: persist state, release lock, exit. `ccloop run --continue` re-enters the escalated state. |

If killed while ESCALATED, `state.json` marks the run as escalated;
`ccloop run --continue` re-renders the escalated screen.

### 9.7 Notifications

- **Push**: HTTP POST to `push_url`. Body is plain text. Designed for
  ntfy.sh, Pushover, etc.
- **Webhook**: HTTP POST to `webhook_url`. Body is a JSON envelope
  (run id, step number, reason, trail, dashboard pointer).
- **Heartbeat**: HTTP POST to `heartbeat_url` (optional). Body is a
  small JSON envelope (run id, step, outcome, state, ts). Fired
  after every step (any outcome, including SDK throws) and on done.
  Designed for healthchecks.io-style endpoints so an off-device
  monitor can alert when ccloop goes silent overnight. Best-effort
  with a 10s timeout per ping; not rate-limited locally — the
  monitoring endpoint enforces its own cadence policy.

Either or both can be configured; if neither, ccloop logs the
escalation to `events.jsonl` and proceeds to the TUI screen without
external notification.

Notifications fire on:
- Entry to ESCALATED (every time, including from `--continue`
  re-rendering).
- Pause exceeding `[notify].pause_alert_seconds` (once per pause).
- Run completion (DONE) if `[notify].notify_on_done = true` (default
  `false`).

Rate limit: at most one per channel per minute. Drops duplicates
within the window.

### 9.8 What ccloop does NOT do on failure

- No automatic spec rewrites (Goal Non-#3).
- No model downgrades.
- No auto-revert without user confirmation.

---

## 10. Guardrails

Hard bounds on a run, enforced independently of done detection or
failure counting. Any guardrail trip terminates the run with status
`guardrail_trip`.

### 10.1 The three guardrails

| Guardrail | Default | Config | Checked at |
|---|---|---|---|
| Max steps | 200 | `[loop].max_steps` | Step pre-flight (§4 step 2) |
| Max wall-clock | `8h` | `[loop].max_wall_clock` (parse-duration string) | Step pre-flight |
| Dirty tree on start | enforced | none (not user-configurable) | Instance start |

`max_steps` or `max_wall_clock` set to `0` (or `""` for the duration)
disables that guardrail.

### 10.2 Max steps

Tracked in `state.json` as `current_step`, persisted across
`--continue`. Pre-flight check: `if current_step > max_steps: trip`.
The counter is the *run*'s, not the *instance*'s.

### 10.3 Max wall-clock

Duration accumulates across all instances of a run (`state.json`
tracks `wall_clock_ms`). Pause time is **not** counted; cadence-sleep
time **is** counted.

Duration string parsed by `parse-duration`: accepts `"8h"`, `"30m"`,
`"1d 2h"`, `"1.5h"`, `"90m"`, etc.

### 10.4 Dirty-tree policy on start

ccloop refuses to start an instance if the working tree has
uncommitted changes the user didn't author intentionally:

- **`ccloop run` (fresh)**: tree must be clean. Otherwise refuse with
  an error pointing at `git status`.
- **`ccloop run --continue`**: a dirty tree means the previous
  instance was killed mid-step (SIGKILL between Claude finishing and
  auto-commit, panic, OS reboot, etc.). ccloop auto-stages everything
  and commits with subject
  `chore(ccloop): recovery commit before resume of step NNNN`, then
  proceeds. The user already opted into resume by passing
  `--continue` (and confirming the matrix prompt), so attributing the
  changes to a recovery commit is the safe default — anything the
  user added during the pause is preserved in git history rather than
  silently entangled with the next step's auto-commit.

The greenfield-init exception (§0): if CWD was empty and `git init`
happened in this same instance, the tree-clean requirement is
trivially satisfied.

### 10.5 Guardrail-trip terminal screen

Distinct from DONE and ESCALATED. Single-screen TUI:

- Reason (which guardrail, with the limit and actual value).
- Run summary (steps completed, wall-clock, last commit sha).
- Single-key controls:
  - `q` — quit (default).
  - `e` — edit `ccloop.toml` to raise the limit; on save, `--continue`
    will be accepted.

Notifications fire on guardrail trip (push + webhook).

### 10.6 What guardrails do NOT bound

- **Inferences per step** — `[claude].max_turns_per_step`, the SDK's
  `maxTurns`. Hits inside the SDK as `error_max_turns`, surfacing as
  a step failure (§9), not a guardrail trip.
- **Token caps** — ccloop does not bound directly. Cost is the proxy
  (parked for post-MVP — see ROADMAP).
- **Disk usage / file-count** — out of scope. The sandbox confines
  writes to CWD; runaway disk usage is the project's problem.

---

## 11. Observability

### 11.1 Surfaces

Four surfaces, in decreasing real-timeness:

1. **TUI** — live, in-process, foreground only. Reads from in-memory
   event bus.
2. **Event log** — `./.ccloop/events.jsonl`, append-only, durable.
3. **Step records** — `./.ccloop/steps/NNNN.json`, per-step.
4. **State file** — `./.ccloop/state.json`, durable.

The TUI reads from the event bus and polls the state file / step
records for derived metrics. It never reads `events.jsonl` directly.

### 11.2 TUI architecture

- Renderer: `ink` + `ink-scroll-view` for the scrollable panes.
- Tick: 250ms render tick. Independent of the step loop.
- Event bus: in-memory queue. Step lifecycle code emits; TUI
  subscribes. Most events are also written to `events.jsonl` by a
  separate writer; the bus-only `stream_chunk` event (carrying live
  SDK turn events for the Now pane) is **not** persisted — it would
  bloat the durable log without paying rent.
- Polling: usage endpoint (§7.6) every 30s. Step records read on
  completion.
- Resize: terminal resize triggers re-layout; renders minimal layout
  below ~80×24.

### 11.3 TUI states

| State | Trigger |
|---|---|
| `STARTING` | Instance start; splash with validation progress |
| `RUNNING` | Steps in flight; full dashboard |
| `PAUSED` | §8; pause screen with countdown |
| `ESCALATED` | §9; escalation screen with controls |
| `GUARDRAIL_TRIP` | §10; same shape as ESCALATED, different reason |
| `DONE` | DONE.md detected; success screen with summary |

### 11.4 Dashboard content (RUNNING)

The dashboard is a single column of bordered panes. Three panes are
**focusable** (scrollable, keyboard-navigable); the rest are static.

| Pane | Focusable? | Source |
|---|---|---|
| header (state · step · cost · tokens · cwd) | no | `state.json` + wall clock + rolling step-record averages |
| **now** (live current-step stream) | yes | bus `stream_chunk` events parsed from SDK assistant / tool_use / tool_result blocks; cleared on `step_start` |
| usage (5h / weekly utilization bars) | no | `/api/oauth/usage` cache (§7.6) |
| **recent steps** | yes | `./.ccloop/steps/*.json`, all entries (pane scrolls) |
| **log** (human-readable event tail) | yes | bus events formatted; 500-entry ring buffer |
| controls hint | no | static, per-state |

**Focus model.** Exactly one focusable pane has keyboard focus at any
time. The focused pane renders with a double-line border in `cyan`;
unfocused focusable panes render with a rounded `gray` border. Static
panes render with a rounded default border. Initial focus is `now`.

**Keyboard.** In RUNNING / PAUSED / DONE:

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle focus forward / backward through available panes |
| `↑` / `↓` | Scroll focused pane by one line |
| `PgUp` / `PgDn` | Scroll focused pane by one viewport |
| `g` / `G` | Top / bottom of focused pane (vim-style) |
| `Ctrl-C` | Stop the loop |

ESCALATED and GUARDRAIL_TRIP keep their state-specific single-letter
menu keys (§9.6, §10.5) and disable scroll keys.

**Auto-tail.** Each focusable pane auto-scrolls to the bottom on new
content unless the user has manually scrolled away from the bottom.
Pressing `G` (or scrolling back to the bottom) re-engages auto-tail.

**Now-pane content.** A flat sequence of `TurnEvent`s built per step:
- `turn_start` — separator marking a new Anthropic turn
- `assistant_text` — prose blocks emitted by the model
- `tool_use` — tool name + truncated input summary (e.g. `▶ Bash · bun test`)
- `tool_result` — pass/fail glyph + truncated excerpt
- `idle` — synthetic, used during cadence sleeps between steps

The Now pane is cleared at each `step_start` so it always reflects the
*current* step's stream, not the entire run.

### 11.5 Event log schema

`./.ccloop/events.jsonl`, one JSON object per line. Common fields:

```jsonc
{
  "ts": "2026-04-27T14:13:42.123Z",
  "run_id": "<uuid>",
  "step": 47,
  "type": "<event-type>",
  // additional fields per type
}
```

MVP event types:

| Type | When | Extra |
|---|---|---|
| `instance_start` | Process startup, after state load | `ccloop_version`, `cwd`, `git_sha` |
| `instance_exit` | Cleanup after `runLoop` returns | `reason`, `exit_code` |
| `step_start` | Pre-flight begins | none |
| `step_end` | Post-flight completes | `subtype`, `stop_reason`, `duration_ms`, `cost_usd`, `commit_sha`, `commit_subject`, `outcome` |
| `step_failed` | Step failure | `category`, `error_excerpt` |
| `pause_enter` | §8 pause begins | `reason`, `until`, `window` |
| `pause_exit` | Pause ends | `wake_reason` |
| `escalate` | §9 escalation | `reason` |
| `escalation_resolved` | Operator picked an action at the escalation menu | `action` (`continue` / `revert` / `edit_spec` / `quit`) |
| `guardrail_trip` | §10 trip | `which`, `limit`, `actual` |
| `notification_sent` | Push/webhook channel attempt resolved | `channel`, `ok`, `status`, `error?` |
| `usage_degraded` | Proactive usage endpoint unavailable / rate-limited | `status`, `reason` |
| `cache_warning` | Cache hit rate below threshold for N consecutive steps (§11) | `streak`, `rate` |
| `recovery_commit` | §10.4 dirty-tree recovery committed unsaved work from a crashed prior instance | `commit_sha`, `commit_subject` |
| `done` | DONE.md detected | `final_commit_sha` |

Unknown event types are not validated — append-only and tolerant.

### 11.6 Step record schema

`./.ccloop/steps/NNNN.json`:

```jsonc
{
  "step": 47,
  "run_id": "<uuid>",
  "started_at": "...",
  "ended_at": "...",
  "duration_ms": 131864,
  "outcome": "success" | "failure" | "no-op",
  "subtype": "success",
  "stop_reason": "end_turn",
  "session_id": "...",
  "num_turns": 12,
  "usage": {
    "input_tokens": 1240,
    "output_tokens": 1180,
    "cache_read_input_tokens": 7600,
    "cache_creation_input_tokens": 0
  },
  "cost_usd": 0.043,
  "cache_hit_rate": 0.91,
  "commit_sha": "a3f1c92",
  "commit_subject": "fix(parser): correct token span end",
  "failure": null
}
```

### 11.7 State file schema

`./.ccloop/state.json`. Replaces atomically (write to `.tmp`, rename).

```jsonc
{
  "schema_version": 1,
  "run_id": "<uuid>",
  "started_at": "<iso>",
  "current_step": 48,
  "wall_clock_ms": 9120000,
  "session_id": "...",
  "consecutive_failures": 0,
  "no_progress_count": 0,
  "diff_hashes_recent": ["...", "...", "..."],
  "state": "running" | "paused" | "escalated" | "guardrail_trip" | "done",
  "pause": null | { "until": "<iso>", "reason": "...", "window": "five_hour" },
  "escalation": null | { "reason": "...", "trail": [...] },
  "guardrail_trip": null | { "which": "...", "limit": ..., "actual": ... }
}
```

### 11.8 Logging

Plain-text logs to stderr. Levels driven by `CCLOOP_LOG_LEVEL`
(default `info`).

The TUI captures stderr internally and routes it into the events
panel.

### 11.9 Post-mortem affordances

After termination, the user has everything in `./.ccloop/`:
`events.jsonl`, `steps/*.json`, `progress.md`, `state.json`. plus
git log of auto-commits.

ccloop ships **no `ccloop log` / `ccloop status` subcommand for MVP**
— `cat`, `jq`, `git log` suffice. CLI inspection commands are a
fast-follow.

### 11.10 What ccloop does NOT observe

- Process metrics (CPU / RSS).
- Git operations beyond auto-commit.
- The user's other terminal sessions / editors.

---

## 12. Configuration & CLI Reference

### 12.1 `ccloop.toml` — full schema

```toml
schema_version = 1

[loop]
max_steps              = 200
max_wall_clock         = "8h"
target_cadence_seconds = 240

pause_at_utilization     = 95.0
escalate_at_utilization  = 80.0

rate_limit_default_pause_seconds = 3600

[claude]
yolo_mode                  = false
max_turns_per_step         = 50         # Anthropic's `maxTurns` per ccloop step
                                        # (Anthropic 'turn' = ccloop 'inference';
                                        # see §2.5)
max_continuations_per_step = 5          # max pause_turn auto-continuations
effort                     = "xhigh"

[failure]
consecutive_failures_before_escalation = 3
backoff                                 = [30, 60, 120]
loop_detection_repeats                  = 3
no_progress_threshold                   = 5

[notify]
push_url             = ""
webhook_url          = ""
pause_alert_seconds  = 1800
notify_on_done       = false

[prompt]
template_path = ""
```

Empty strings, zeros, and explicit `false` mean "disabled" or
"default" depending on the field.

### 12.2 Field semantics

- **`schema_version`** — incremented when ccloop changes how an
  existing key is interpreted. ccloop refuses to load configs with a
  higher version than it knows.
- **`[loop].target_cadence_seconds = 0`** — disables cadence sleep.
- **`[loop].max_wall_clock = ""`** — disables.
- **`[claude].yolo_mode = true`** — only honored if user has read
  §6.5 and explicitly opted in. Warns on every instance start.
- **`[notify].push_url`** — for ntfy.sh-style services. POSTs
  `text/plain`. Webhook POSTs `application/json`.

### 12.3 CLI flags

Precedence: **flag > `ccloop.toml` > built-in default**.

| Flag | Maps to | Notes |
|---|---|---|
| `--max-steps N` | `[loop].max_steps` | |
| `--max-wall-clock D` | `[loop].max_wall_clock` | parse-duration string |
| `--cadence N` | `[loop].target_cadence_seconds` | |
| `--yolo` | `[claude].yolo_mode = true` | |
| `--prompt PATH` | `[prompt].template_path` | |
| `--log-level LEVEL` | `CCLOOP_LOG_LEVEL` | |
| `--no-color` | sets `NO_COLOR` | |
| `--continue` | (matrix override; see §12.4) | |
| `-y, --yes` | auto-accept default-yes prompts | |

Flags omitted intentionally:

- `--push-url`, `--webhook-url` — secret-shaped; config-file only.
- `--pause-at-utilization`, `--escalate-at-utilization` —
  config-file only.

### 12.4 Subcommands

```
ccloop                  print help, exit 0 (same as --help)
ccloop --help, -h       print help
ccloop --version, -V    print version
ccloop init             scaffold SPEC.md and ccloop.toml
ccloop run [flags]      start or resume a run
```

`ccloop run` matrix:

| State | Default behavior |
|---|---|
| `.ccloop/` present, `SPEC.md` present | Prompt: `Existing run found (step N, last activity <t>). Continue? [Y/n]`. `y`/Enter → resume; `n` → exit 0. |
| `.ccloop/` absent, `SPEC.md` present | Start fresh. No prompt. |
| `.ccloop/` absent, `SPEC.md` absent | Prompt: `No SPEC.md found. Scaffold? [Y/n]`. `y`/Enter → run `ccloop init`, exit with note. `n` → exit 0. |
| `.ccloop/` present, `SPEC.md` absent | Refuse with error. Manual intervention required. |

Skip the matrix:

- `--continue` — explicit "yes, resume." Refuses if `.ccloop/` is
  absent.
- `--yes` / `-y` — auto-accept.

No `--force` flag in MVP. Fresh-over-existing requires the user to
manually `rm -rf .ccloop/`.

### 12.5 `ccloop init`

Creates two files in CWD if absent:

- `SPEC.md` from `templates/SPEC.md`.
- `ccloop.toml` from `templates/ccloop.toml`.

Refuses to overwrite. Does not create `.ccloop/`. Does not init git.

### 12.6 Exit codes

| Code | Meaning |
|---|---|
| 0 | Run completed (`DONE.md` present at exit) |
| 1 | Generic error (validation failed, missing inputs, config error) |
| 2 | Auth missing or invalid |
| 3 | Lock held by another instance |
| 4 | Guardrail tripped |
| 5 | Escalated and `q`-quit |
| 130 | SIGINT |
| 143 | SIGTERM |

### 12.7 Help text

```
ccloop — Claude Code loop runner

Drives a Claude Code session in a loop against a SPEC.md until done.

Usage:
  ccloop run [flags]      start or resume a run
  ccloop init             scaffold SPEC.md and ccloop.toml
  ccloop --help           this help
  ccloop --version        print version

Common flags for `ccloop run`:
  --continue              resume an existing run; no prompt
  -y, --yes               auto-accept default-yes prompts
  --max-steps N           cap total steps in this run
  --max-wall-clock D      cap wall-clock; "8h", "30m", "1d 2h"
  --cadence N             seconds between step starts
  --yolo                  bypass tool permission scoping
  --prompt PATH           override prompt template
  --log-level LEVEL       debug | info | warn | error
  --no-color              disable ANSI

Required environment:
  CLAUDE_CODE_OAUTH_TOKEN  generate with: claude setup-token

Files (in current directory):
  SPEC.md                 required: spec to drive against
  ccloop.toml             optional: config overrides
  .ccloop/                ccloop's run state (deletable post-run)

Quick start in an empty directory:
  ccloop init             scaffolds SPEC.md and ccloop.toml
  $EDITOR SPEC.md         fill in the spec and Verification Requirements
  ccloop run              start the loop
```

---

## 13a. ccloop Repo Layout

This repo. What an agent working on ccloop should expect.

```
.claude/
  CLAUDE.md           Agent guardrails. Read first.
  SPEC.md             ccloop's own spec — this document. Ephemeral.
  settings.json       (optional) Claude Code project-level settings.

templates/
  SPEC.md             Example/starter spec for users of ccloop.
  ccloop.toml         Example config with all keys at defaults.

src/                  TypeScript source, Bun-native.
  index.ts            Entrypoint. Argv parse, subcommand dispatch.
  cli/                Subcommand implementations (run, init, help).
  loop/               Step loop, state machine, telemetry rollup.
  sdk/                Agent SDK wrapper, prompt assembly, sandbox glue.
  usage/              /api/oauth/usage client and pause logic.
  state/              state.json, events.jsonl, step records, lockfile.
  tui/                ink components and event-bus.
  config/             ccloop.toml schema, parse-duration, validation.

prompt-template.md    Default embedded template (§6.8).
ROADMAP.md            Fast-follows and post-MVP items.
IDEAS.md              Sibling-project ideas.
README.md             Public-facing intro, install, quickstart.
package.json          Minimal — bun-native, no build step.
tsconfig.json         For editor support; Bun runs TS directly.
.gitignore            Excludes .ccloop/ at any depth.
```

Conventions:

- **No `dist/`** — Bun runs TypeScript directly. `package.json`'s
  `bin` points at `src/index.ts`.
- **No `tests/` directory in MVP.** Tests live next to code (`src/loop/step.test.ts`). Run with `bun test`.
- **Two SPEC.md files exist**: `templates/SPEC.md` (example for
  users) and `.claude/SPEC.md` (ccloop's own). Repo root has none.
- **`prompt-template.md` lives at root** for editability without TS
  reload.

---

## 13b. Working-Directory Contract

What ccloop creates and uses in the user's CWD.

```
SPEC.md                          (user-authored, required)
ccloop.toml                      (user-authored, optional)

DONE.md                          (Claude-authored when conditions met;
                                  ccloop never touches it)

.ccloop/
  state.json                     run state (§11.7)
  ccloop.lock                    held by active instance
  events.jsonl                   append-only event log
  progress.md                    cross-step memory (§2.3)
  steps/
    0001.json                    one per step (§11.6)
    0002.json
    ...
  prompt.md                      (optional) prompt template override

(everything else is the target project's own files —
 owned by Claude during the run)
```

### 13b.1 What ccloop reads

- `SPEC.md` every step.
- `ccloop.toml` once at instance start.
- `.ccloop/state.json` at instance start.
- `.ccloop/progress.md` every step.
- `DONE.md` at instance start, before each step, after each step.
- The git working tree — for auto-commit and dirty-tree checks.

### 13b.2 What ccloop writes

- `.ccloop/` and everything inside.
- `git` commits — one per step (plus init commit and recovery commits).

ccloop never writes outside `.ccloop/` and `.git/` directly. *Claude*,
during a step, may write anywhere in CWD; the sandbox (§6.5) bounds
that reach.

### 13b.3 Lifecycle of `.ccloop/`

- **Created** by `ccloop run` on first step's pre-flight.
- **Updated atomically** on every step's post-flight.
- **Locked** for instance lifetime via `ccloop.lock`. Stale-lock
  detection (PID dead) lets the next instance recover.
- **Untouched** after a successful run — ccloop does not auto-delete.
  User deletes when ready.

### 13b.4 Per Goal #6: deletable post-run

Deleting `./.ccloop/` after success leaves a clean target project —
git history, code, tests, `DONE.md`, `SPEC.md`. Indistinguishable
from human-authored.

Enforced structurally:

- No state ccloop *needs* lives outside `.ccloop/`.
- ccloop never writes to `~/.config/`, `~/.cache/`, or `~/.claude/`.
- ccloop's git commits use the user's git config.

### 13b.5 If the user pollutes `.ccloop/`

- `state.json` — schema-validated on load. Mismatch → refuse
  `--continue`; ask user to fix or delete.
- `events.jsonl` — append-only and tolerant; corruption truncates to
  last valid line.
- Step records — read individually; malformed skipped with warning.

ccloop does not "self-heal" — if the user broke it, fix or delete.

---

## 13c. Design Loop

The design loop (`ccloop design`) is an interactive mode that produces
a validated `SPEC.md` for the build loop to consume. Unlike the build
loop's autonomous execution, the design loop is human-in-the-loop:
the agent guides the user through a structured design process.

**Implementation location**: `src/design/`

**Key modules**:
- `types.ts` — core types (DesignPhase, DesignSessionState, events)
- `constants.ts` — phase order, default config, artifact paths
- `prompts.ts` — system prompt + per-phase scaffolding
- `draft.ts` — draft initialization, validation (reuses `validateSpec`), promotion
- `session.ts` — metadata persistence for resume
- `events.ts` — lifecycle events to `.ccloop/events.jsonl`
- `approver.ts` — PreToolUse hook restricting writes to `.ccloop/design/`
- `acceptance.ts` — validation gate logic when user signals accept

**Design artifacts** (all under `./.ccloop/design/`):
- `spec.draft.md` — in-progress spec
- `ROADMAP.md` — future scope (optional, promoted if exists)
- `IDEAS.md` — idea parking lot (optional, promoted if exists)
- `TECH-DEBT.md` — intentional shortcuts (optional, promoted if exists)
- `session.json` — resume metadata (phase, turn count, cost)
- `last-session.md` — graceful-shutdown summary (Ctrl+C)

**Phase flow** (linear in MVP):
1. Vision → 2. Users → 3. Scope → 4. Architecture → 5. Milestones → 6. Acceptance

**Agent tools** (sandbox-restricted via `makeDesignApprover`):
- Read/Grep/Glob (read-only, anywhere in CWD)
- Edit/Write (path-restricted to `.ccloop/design/` only)
- Bash (sandboxed via bwrap/sandbox-exec, same as build loop)
- WebSearch/WebFetch
- `ask_user` MCP tool (in-process server, multiple-choice prompts)

**Resume model**: On re-invocation, if `spec.draft.md` exists, load it
as starting state. Conversation history is **not** restored (fresh SDK
session each time); the draft itself provides continuity.

**Acceptance flow**: When user signals accept (via `ask_user` or future
slash command), run `validateSpec` on draft. If validation fails,
surface errors and stay in loop. If validation passes, prompt user to
confirm promotion. On confirm, copy draft + sibling artifacts to
project root, offer to launch `ccloop build`.

**Configuration**: `ccloop.toml` `[design]` section. Keys: `model`
(defaults to Opus, independent of `[build].model`), `max_turns`
(default 100), `effort` (default "high"), `enable_tui` (default true).

**Event emission**: Design sessions emit to the same `events.jsonl` as
the build loop. Event types: `design_session_start`,
`design_phase_enter`, `ask_user_asked`, `ask_user_answered`,
`draft_edit`, `design_session_accept`, `design_session_abort`,
`design_session_end`.

**No global state**: All design state lives in `.ccloop/design/`.
Deleting that directory clears design session; deleting `.ccloop/`
clears everything.

---

## 14. Known Unknowns

Items requiring empirical validation during build, not assumption.

### 14.1 SDK & invocation

- **SDK idle timeout under long tool runs.** ccloop wraps iterator
  drain in `Promise.race` with a 30-min timeout (§6.3); right value
  is workload-dependent. *Resolve*: instrument first run; record
  longest single tool execution; set timeout to ~3× that.
- **`pause_turn` continuation behavior with cache.** Whether each
  continuation pays a fresh cache miss or hits existing cache.
  *Resolve*: log `cache_read_input_tokens` per `ResultMessage` across
  continuations.
- **SDK behavior when both `CLAUDE_CODE_OAUTH_TOKEN` and
  `ANTHROPIC_API_KEY` are set.** Documentation silent. *Resolve*:
  empirical test before MVP ships; document in §6.6.
- **SDK `maxTurns` semantics under `pause_turn` continuations.**
  Reset across continuations or accumulate? *Resolve*: same test.

### 14.2 Usage endpoint

- **`/api/oauth/usage` schema stability.** Endpoint undocumented.
  *Resolve*: tolerant validator; track upstream changes.
- **Endpoint-broken-for-Max-subscribers (#30930).** Persistent 429
  for some users. *Resolve*: verify on a Max subscription before
  ship; if still broken, document degraded path as expected.
- **Reactive rate-limit error format.** §8.4 parses error text for
  reset times. *Resolve*: deliberately exhaust a small test plan to
  capture the error in stream-json output; pin the parser pattern.

### 14.3 Cache & cadence

- **Realistic cache hit rate baseline.** §7.5 thresholds are guesses.
  *Resolve*: instrument first 5+ real runs; recompute from observed
  distribution.
- **Cadence-vs-cost tradeoff at 1h cache.** *Resolve*: A/B at least
  one run with reduced cadence; observe wall-clock and cost.

### 14.4 Failure detection heuristics

- **Git-diff hash robustness** (§9.4). Whitespace, file-mode, edit
  reordering. *Resolve*: log diff hashes; review post-run; tune
  normalization.
- **`no_progress` threshold** (§9.5). Default 5 may be aggressive.
  *Resolve*: observe distribution; adjust.

### 14.5 Working-tree handling

- **Dirty-tree on `--continue`** (§10.4). MVP auto-creates a
  recovery commit. *Resolve*: confirm in practice that this never
  silently swallows user-intended edits; if it does, soften to
  "warn and ask".

### 14.6 Operational

- **Notification rate-limit** (§9.7). 1/min likely fine; flag if
  noisy.
- **Auto-commit message derivation.** §4 step 8 derives from final
  assistant text. Likely rule: first non-blank line, stripped of
  leading markdown, capped at 72 chars. *Resolve*: settle during
  implementation.
- **`extra_usage` (overage credits).** §8.8 says warn-only. *Resolve*:
  ship; revisit if user feedback says otherwise.

This section is the punch-list. The implementing agent closes each
item by capturing data and updating the relevant section. After MVP,
this section can be deleted along with the rest of `.claude/`.

