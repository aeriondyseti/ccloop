import { Box, Text, useInput } from "ink";
import React from "react";
import {
  formatBar, formatCost, formatCountdown, formatDuration,
  formatPct, formatTokens,
} from "./format.ts";
import type { TuiViewModel } from "./types.ts";

export type MenuKey = "c" | "r" | "e" | "q";

export interface DashboardProps {
  view: TuiViewModel;
  /** When set, ESCALATED / GUARDRAIL_TRIP screens dispatch their
   *  hotkeys through this callback. Each TUI state filters to the
   *  keys it actually advertises (§9.6, §10.5). */
  onMenuKey?: (key: MenuKey) => void;
}

export function Dashboard({ view, onMenuKey }: DashboardProps): React.ReactElement {
  switch (view.state) {
    case "STARTING": return <Starting view={view} />;
    case "RUNNING":  return <Running view={view} />;
    case "PAUSED":   return <Paused view={view} />;
    case "ESCALATED": return <Escalated view={view} onMenuKey={onMenuKey} />;
    case "GUARDRAIL_TRIP": return <GuardrailTrip view={view} onMenuKey={onMenuKey} />;
    case "DONE": return <Done view={view} />;
  }
}

function useMenuKey(
  allowed: ReadonlyArray<MenuKey>,
  onMenuKey: ((key: MenuKey) => void) | undefined,
): void {
  useInput((input) => {
    if (!onMenuKey) return;
    const ch = input.toLowerCase() as MenuKey;
    if (allowed.includes(ch)) onMenuKey(ch);
  }, { isActive: !!onMenuKey });
}

function Header({ view, title, color }: { view: TuiViewModel; title: string; color: string }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color} bold>{title}</Text>
        <Text>  step {view.step}  ·  elapsed {formatDuration(view.elapsedMs)}</Text>
      </Box>
      <Text dimColor>{view.cwd}</Text>
    </Box>
  );
}

function UsageBars({ view }: { view: TuiViewModel }) {
  if (!view.usage) {
    return <Text dimColor>usage: (no data)</Text>;
  }
  const { five_hour, seven_day } = view.usage;
  return (
    <Box flexDirection="column">
      <Text>5h    {formatBar(five_hour.utilization)} {five_hour.utilization.toFixed(1)}%  resets {formatCountdown(five_hour.resets_at)}</Text>
      <Text>week  {formatBar(seven_day.utilization)} {seven_day.utilization.toFixed(1)}%  resets {formatCountdown(seven_day.resets_at)}</Text>
    </Box>
  );
}

function Stats({ view }: { view: TuiViewModel }) {
  return (
    <Box>
      <Text>cost {formatCost(view.rollingCostUsd)}  ·  tokens in {formatTokens(view.rollingTokensIn)} / out {formatTokens(view.rollingTokensOut)}  ·  cache hit {formatPct(view.averageCacheHitRate)}</Text>
    </Box>
  );
}

function RecentSteps({ view }: { view: TuiViewModel }) {
  if (view.recentSteps.length === 0) {
    return <Text dimColor>(no completed steps yet)</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text bold>recent steps</Text>
      {view.recentSteps.slice(-5).map((s) => (
        <Text key={s.step}>
          {String(s.step).padStart(4, "0")}  {outcomeMark(s.outcome)}  {formatCost(s.cost_usd).padStart(8)}  {formatPct(s.cache_hit_rate).padStart(4)}  {formatDuration(s.duration_ms).padStart(8)}  {s.commit_subject}
        </Text>
      ))}
    </Box>
  );
}

function outcomeMark(o: "success" | "failure" | "no-op"): string {
  if (o === "success") return "✔";
  if (o === "failure") return "✘";
  return "·";
}

function Events({ view }: { view: TuiViewModel }) {
  if (view.events.length === 0) {
    return <Text dimColor>(no events)</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text bold>events</Text>
      {view.events.slice(-6).map((e, i) => (
        <Text key={i} dimColor>{e}</Text>
      ))}
    </Box>
  );
}

function Controls({ hint }: { hint: string }) {
  return <Text dimColor>{hint}</Text>;
}

// ===== state-specific layouts =====

function Starting({ view }: { view: TuiViewModel }) {
  return (
    <Box flexDirection="column">
      <Header view={view} title="STARTING" color="yellow" />
      <Text dimColor>validating SPEC.md, loading config, opening SDK…</Text>
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Running({ view }: { view: TuiViewModel }) {
  return (
    <Box flexDirection="column" rowGap={1}>
      <Header view={view} title="RUNNING" color="green" />
      <UsageBars view={view} />
      <Stats view={view} />
      <RecentSteps view={view} />
      <Events view={view} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Paused({ view }: { view: TuiViewModel }) {
  return (
    <Box flexDirection="column" rowGap={1}>
      <Header view={view} title="PAUSED" color="cyan" />
      <Text>reason: {view.pause?.reason ?? "—"}</Text>
      <Text>resumes in: {view.pause ? formatCountdown(view.pause.until) : "—"}</Text>
      <UsageBars view={view} />
      <Events view={view} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Escalated({
  view, onMenuKey,
}: { view: TuiViewModel; onMenuKey?: (k: MenuKey) => void }) {
  useMenuKey(["c", "r", "e", "q"], onMenuKey);
  return (
    <Box flexDirection="column" rowGap={1}>
      <Header view={view} title="ESCALATED" color="red" />
      <Text>reason: {view.escalation?.reason ?? "—"}</Text>
      <RecentSteps view={view} />
      <Events view={view} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function GuardrailTrip({
  view, onMenuKey,
}: { view: TuiViewModel; onMenuKey?: (k: MenuKey) => void }) {
  useMenuKey(["q", "e"], onMenuKey);
  return (
    <Box flexDirection="column" rowGap={1}>
      <Header view={view} title="GUARDRAIL TRIP" color="magenta" />
      <Text>which: {view.guardrail?.which ?? "—"}</Text>
      <Text>limit: {String(view.guardrail?.limit ?? "—")}</Text>
      <Text>actual: {String(view.guardrail?.actual ?? "—")}</Text>
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Done({ view }: { view: TuiViewModel }) {
  return (
    <Box flexDirection="column" rowGap={1}>
      <Header view={view} title="DONE" color="green" />
      <Text>final commit: {view.done?.finalCommitSha ?? "—"}</Text>
      <Stats view={view} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}
