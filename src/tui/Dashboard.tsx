import { Box, Text } from "ink";
import React, { useRef, useState } from "react";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { formatCountdown } from "./format.ts";
import type {
  FocusTarget,
  LifecycleEntry,
  TranscriptEntry,
  TurnEvent,
  TuiViewModel,
} from "./types.ts";
import {
  Frame,
  Pane,
  Controls,
  Header,
  UsagePane,
  useCtrlC,
  useFocusCycle,
  useScrollKeys,
  useAutoTail,
  useMenuKey,
  usePauseKey,
  type MenuKey,
} from "./shared/index.ts";

export type { MenuKey };

export interface DashboardProps {
  view: TuiViewModel;
  /** When set, ESCALATED / GUARDRAIL_TRIP screens dispatch their
   *  hotkeys through this callback. Each TUI state filters to the
   *  keys it actually advertises (§9.6, §10.5). */
  onMenuKey?: (key: MenuKey) => void;
  /** Ctrl+C handler. Called once per Ctrl+C press; the CLI owns the
   *  press-counting / force-exit policy. We pass `exitOnCtrlC: false`
   *  to Ink's `render()` so this is the single Ctrl+C path — without
   *  it, Ink would unmount the React tree on first press while our
   *  loop kept running. */
  onInterrupt?: () => void;
  /** Operator pause toggle. Active in RUNNING / OPERATOR_PAUSED only;
   *  bound to the lowercase `p` key. */
  onTogglePause?: () => void;
}

const FOCUS_ORDER: readonly FocusTarget[] = ["transcript"];

export function Dashboard({
  view, onMenuKey, onInterrupt, onTogglePause,
}: DashboardProps): React.ReactElement {
  useCtrlC(onInterrupt);
  const pauseActive = view.state === "RUNNING" || view.state === "OPERATOR_PAUSED";
  usePauseKey(pauseActive, onTogglePause);
  return <Frame>{pickScreen(view, onMenuKey)}</Frame>;
}

function pickScreen(
  view: TuiViewModel,
  onMenuKey?: (k: MenuKey) => void,
): React.ReactElement {
  switch (view.state) {
    case "STARTING": return <Starting view={view} />;
    case "RUNNING":  return <Running view={view} />;
    case "PAUSED":   return <Paused view={view} />;
    case "OPERATOR_PAUSED": return <OperatorPaused view={view} />;
    case "ESCALATED": return <Escalated view={view} onMenuKey={onMenuKey} />;
    case "GUARDRAIL_TRIP": return <GuardrailTrip view={view} onMenuKey={onMenuKey} />;
    case "DONE": return <Done view={view} />;
  }
}

// ===== content =====

function BuildLoopHeader({ view }: { view: TuiViewModel }): React.ReactElement {
  const stateColor =
    view.state === "RUNNING" ? "green"
    : view.state === "PAUSED" ? "cyan"
    : view.state === "OPERATOR_PAUSED" ? "yellow"
    : view.state === "ESCALATED" ? "red"
    : view.state === "GUARDRAIL_TRIP" ? "magenta"
    : view.state === "DONE" ? "green"
    : "yellow";
  const status = cadenceLabel(view);
  return (
    <Header
      state={view.state}
      stateColor={stateColor}
      heartbeat={view.heartbeat}
      step={view.step}
      status={status || undefined}
      elapsedMs={view.elapsedMs}
      checklist={view.checklist}
      rollingCostUsd={view.rollingCostUsd}
      rollingTokensIn={view.rollingTokensIn}
      rollingTokensOut={view.rollingTokensOut}
      averageCacheHitRate={view.averageCacheHitRate}
      cacheLowStreak={view.cacheLowStreak}
      cwd={view.cwd}
    />
  );
}

/** Header status segment: "cadence X/Y s" while in a cadence wait,
 *  empty otherwise. The TUI rerenders on the heartbeat tick (1 Hz),
 *  which is enough for a per-second countdown. */
function cadenceLabel(view: TuiViewModel): string {
  if (!view.cadenceWait) return "";
  const elapsedMs = Date.now() - Date.parse(view.cadenceWait.startedAt);
  const elapsedS = Math.max(0, Math.floor(elapsedMs / 1000));
  const totalS = Math.max(1, Math.floor(view.cadenceWait.totalMs / 1000));
  const clamped = Math.min(elapsedS, totalS);
  const remaining = Math.max(0, totalS - clamped);
  return `next step in ${remaining}s (${clamped}/${totalS})`;
}

interface FocusableProps {
  view: TuiViewModel;
  focus: FocusTarget;
}

// ===== Transcript pane (replaces Now + Log) =====

function TranscriptPane({ view, focus }: FocusableProps): React.ReactElement {
  const ref = useRef<ScrollViewRef>(null);
  const userScrolledRef = useRef(false);
  const focused = focus === "transcript";
  useAutoTail(view.transcript.length, userScrolledRef, ref);
  useScrollKeys({ focused, userScrolledRef, scrollRef: ref });

  const titleRight = focused
    ? (userScrolledRef.current ? "↑↓ ⇞⇟ · G to live" : "↑↓ ⇞⇟ g/G · live")
    : "";
  const title = transcriptTitle(view);

  if (view.transcript.length === 0) {
    return (
      <Pane title={title} role="focusable" focused={focused}
            titleRight={titleRight} flexGrow={1} flexShrink={1}>
        <Text dimColor>(waiting for the next turn…)</Text>
      </Pane>
    );
  }

  return (
    <Pane title={title} role="focusable" focused={focused}
          titleRight={titleRight} flexGrow={1} flexShrink={1}>
      <ScrollView ref={ref}>
        {view.transcript.map((e, i) => (
          <TranscriptRow key={`${i}-${e.source}`} row={e} />
        ))}
      </ScrollView>
    </Pane>
  );
}

/** Title summarises the most recent activity — turn entries when
 *  available (mirrors the old "now" pane title), otherwise the most
 *  recent lifecycle event so the operator always sees current state. */
function transcriptTitle(view: TuiViewModel): string {
  for (let i = view.transcript.length - 1; i >= 0; i--) {
    const row = view.transcript[i];
    if (!row) continue;
    if (row.source === "turn") return turnTitle(row.entry);
  }
  const last = view.transcript[view.transcript.length - 1];
  if (last && last.source === "lifecycle") return `transcript · ${last.entry.type}`;
  return "transcript";
}

function turnTitle(last: TurnEvent): string {
  switch (last.kind) {
    case "tool_use":
      return `transcript · ▸ ${last.tool} · ${last.summary}`;
    case "tool_result":
      return `transcript · ${last.ok ? "✓" : "✗"} ${last.tool}`;
    case "assistant_text":
      return "transcript · ◌ thinking";
    case "turn_start":
      return `transcript · turn ${last.turn}`;
    case "idle":
      return `transcript · ${last.note}`;
  }
}

function TranscriptRow({ row }: { row: TranscriptEntry }): React.ReactElement {
  if (row.source === "turn") return <TurnRow event={row.entry} />;
  return <LifecycleRow entry={row.entry} />;
}

/** Live SDK turn — styled after my-claude's model/tool blocks: a
 *  small-caps source label followed by the body. The frame border is
 *  borrowed from Pane to keep visuals consistent without pulling in
 *  a separate primitive. */
function TurnRow({ event }: { event: TurnEvent }): React.ReactElement {
  switch (event.kind) {
    case "turn_start":
      return (
        <Box marginTop={1}>
          <Text dimColor>── turn {event.turn} ──</Text>
        </Box>
      );
    case "assistant_text":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta" dimColor>assistant</Text>
          <Text color="magenta">{event.text}</Text>
        </Box>
      );
    case "tool_use":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" dimColor>tool use</Text>
          <Text color="cyan" bold>▸ {event.tool}({event.summary})</Text>
        </Box>
      );
    case "tool_result":
      return (
        <Box flexDirection="column">
          <Text color={event.ok ? "green" : "red"} dimColor>
            {event.ok ? "result" : "error"}
          </Text>
          <Text color={event.ok ? "green" : "red"}>
            {event.ok ? "✓" : "✗"} {event.tool}: {event.excerpt}
          </Text>
        </Box>
      );
    case "idle":
      return <Text dimColor>· {event.note}</Text>;
  }
}

/** Durable lifecycle event — mapped to a typed visual block (system
 *  / harness / error) instead of the old pre-formatted log line. */
function LifecycleRow({ entry }: { entry: LifecycleEntry }): React.ReactElement {
  const time = entry.ts.slice(11, 19);
  const block = lifecycleBlock(entry);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={block.color} dimColor bold>{block.label}</Text>
        <Text dimColor>{"  "}{time}</Text>
      </Box>
      <Text color={block.color} dimColor={block.dim}>{block.text}</Text>
    </Box>
  );
}

interface LifecycleBlock {
  label: string;
  color: string;
  text: string;
  dim?: boolean;
}

function lifecycleBlock(e: LifecycleEntry): LifecycleBlock {
  const s = (k: string): string => String(e[k] ?? "");
  const num = (k: string, fb = 0): number => {
    const v = e[k];
    return typeof v === "number" && Number.isFinite(v) ? v : fb;
  };
  switch (e.type) {
    case "instance_start": {
      const v = e.ccloop_version ? `v${s("ccloop_version")}` : "";
      const sha = s("git_sha").slice(0, 7);
      const tail = [v, sha ? `@${sha}` : ""].filter(Boolean).join(" ");
      return { label: "harness", color: "gray", dim: true,
        text: `instance start${tail ? ` · ${tail}` : ""}` };
    }
    case "instance_exit":
      return { label: "harness", color: "gray", dim: true,
        text: `instance exit · ${s("reason") || "?"} (exit ${e.exit_code ?? "?"})` };
    case "step_start":
      return { label: "system", color: "blue", dim: true,
        text: `step ${num("step")} started` };
    case "step_end": {
      const subtype = s("subtype");
      const dur = formatDurationShort(num("duration_ms"));
      const cost = `$${num("cost_usd").toFixed(2)}`;
      const sha = s("commit_sha").slice(0, 7);
      const out = s("outcome") || subtype;
      const mark = out === "success" ? "✓" : out === "failure" ? "✗" : "·";
      const subj = s("commit_subject").trim();
      const subjPart = subj ? ` · ${subj}` : "";
      return { label: "system", color: out === "success" ? "green" : out === "failure" ? "red" : "blue",
        text: `step ${num("step")} ${mark} ${dur} · ${cost}${sha ? ` · ${sha}` : ""}${subjPart}` };
    }
    case "step_failed":
      return { label: "error", color: "red",
        text: `step ${num("step")} failed: ${s("category") || "unknown"}` };
    case "pause_enter":
      return { label: "system", color: "cyan",
        text: `pause: ${s("reason")} (${s("window")})` };
    case "pause_exit":
      return { label: "system", color: "cyan",
        text: `resume: ${s("wake_reason")}` };
    case "operator_pause_enter":
      return { label: "system", color: "yellow", text: "pause: operator" };
    case "operator_pause_exit":
      return { label: "system", color: "yellow", text: "resume: operator" };
    case "escalate":
      return { label: "error", color: "red", text: `escalate: ${s("reason")}` };
    case "escalation_resolved":
      return { label: "system", color: "green",
        text: `escalation resolved · ${s("action") || "?"}` };
    case "guardrail_trip":
      return { label: "error", color: "magenta",
        text: `guardrail: ${s("which")} = ${s("actual")}` };
    case "usage_degraded":
      return { label: "system", color: "yellow",
        text: `usage degraded: ${s("reason")}` };
    case "cache_warning": {
      const rate = (num("rate") * 100).toFixed(0);
      return { label: "system", color: "yellow",
        text: `cache hit rate ${rate}% for ${num("streak")} steps in a row` };
    }
    case "notification_sent": {
      const ok = e.ok === true;
      const status = e.status === null || e.status === undefined ? "—" : String(e.status);
      const detail = ok ? `ok (${status})` : `failed (${e.error ?? status})`;
      return { label: "harness", color: ok ? "gray" : "red", dim: ok,
        text: `notify ${s("channel") || "?"}: ${detail}` };
    }
    case "recovery_commit": {
      const sha = s("commit_sha").slice(0, 7);
      const subj = s("commit_subject").trim();
      const tail = subj ? ` · ${subj}` : "";
      return { label: "system", color: "green", text: `recovery commit ${sha}${tail}` };
    }
    case "session_rotated": {
      const reason = s("reason") || "?";
      const prev = s("previous_session_id");
      const prevTail = prev ? ` (was ${prev.slice(0, 8)})` : "";
      return { label: "system", color: "cyan",
        text: `session rotated · ${reason}${prevTail}` };
    }
    case "done":
      return { label: "system", color: "green",
        text: `done · ${s("final_commit_sha").slice(0, 7)}` };
    default:
      return { label: e.type, color: "gray", dim: true, text: "" };
  }
}

function formatDurationShort(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${String(r).padStart(2, "0")}s`;
}

// ===== state-specific layouts =====

function Starting({ view }: { view: TuiViewModel }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Pane title={`ccloop · STARTING ${view.heartbeat}`}>
        <Text dimColor>validating SPEC.md, loading config, opening SDK…</Text>
        <Text dimColor>{view.cwd}</Text>
      </Pane>
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function useFocusableLayout(
  view: TuiViewModel,
  available: readonly FocusTarget[],
): FocusTarget {
  const initial = available.includes(view.focus) ? view.focus : (available[0] ?? "transcript");
  const [focus, setFocus] = useState<FocusTarget>(initial);
  useFocusCycle(focus, setFocus, available);
  return focus;
}

function Running({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <TranscriptPane view={view} focus={focus} />
      <UsagePane usage={view.usage} contextTokens={view.lastContextTokens} contextWindowTokens={view.contextWindowTokens} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Paused({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <Pane title="paused">
        <Text>reason:    {view.pause?.reason ?? "—"}</Text>
        <Text>resumes in: {view.pause ? formatCountdown(view.pause.until) : "—"}</Text>
      </Pane>
      <UsagePane usage={view.usage} contextTokens={view.lastContextTokens} contextWindowTokens={view.contextWindowTokens} />
      <TranscriptPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

/** Operator-initiated pause. Same layout as RUNNING with a yellow
 *  banner. The in-flight step + cadence sleep have already completed
 *  by the time this screen is visible. */
function OperatorPaused({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <Pane title="paused (operator)">
        <Text color="yellow">paused between loops — press <Text bold>p</Text> to resume</Text>
        <Text dimColor>the in-flight step finished; ccloop will start the next step on resume</Text>
      </Pane>
      <TranscriptPane view={view} focus={focus} />
      <UsagePane usage={view.usage} contextTokens={view.lastContextTokens} contextWindowTokens={view.contextWindowTokens} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Escalated({
  view, onMenuKey,
}: { view: TuiViewModel; onMenuKey?: (k: MenuKey) => void }): React.ReactElement {
  useMenuKey(["c", "r", "e", "q"], onMenuKey);
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <Pane title="escalated">
        <Text>reason: {view.escalation?.reason ?? "—"}</Text>
      </Pane>
      <TranscriptPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function GuardrailTrip({
  view, onMenuKey,
}: { view: TuiViewModel; onMenuKey?: (k: MenuKey) => void }): React.ReactElement {
  useMenuKey(["q", "e"], onMenuKey);
  return (
    <Box flexDirection="column">
      <BuildLoopHeader view={view} />
      <Pane title="guardrail trip">
        <Text>which:  {view.guardrail?.which ?? "—"}</Text>
        <Text>limit:  {String(view.guardrail?.limit ?? "—")}</Text>
        <Text>actual: {String(view.guardrail?.actual ?? "—")}</Text>
      </Pane>
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Done({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <Pane title="done">
        <Text>final commit: {view.done?.finalCommitSha ?? "—"}</Text>
      </Pane>
      <TranscriptPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}
