/**
 * Shared header component showing state, metrics, and context.
 * Used by both build and design loops.
 */

import { Box, Text } from "ink";
import React from "react";
import { Pane } from "./components.tsx";
import { formatCost, formatDuration, formatPct, formatTokens } from "../format.ts";

export interface HeaderProps {
  /** Loop type label (e.g., "ccloop", "ccloop design") */
  loopLabel?: string;
  /** Current state (e.g., "RUNNING", "PAUSED", "ESCALATED") */
  state: string;
  /** State color for visual feedback */
  stateColor?: "green" | "cyan" | "red" | "magenta" | "yellow";
  /** Heartbeat indicator (toggles to show liveness) */
  heartbeat?: "●" | "○";
  /** Current step number */
  step?: number;
  /** Optional status message (e.g., cadence countdown) */
  status?: string;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Checklist progress */
  checklist?: { done: number; total: number } | null;
  /** Rolling cost in USD */
  rollingCostUsd?: number;
  /** Rolling input tokens */
  rollingTokensIn?: number;
  /** Rolling output tokens */
  rollingTokensOut?: number;
  /** Average cache hit rate */
  averageCacheHitRate?: number;
  /** Cache low streak count */
  cacheLowStreak?: number;
  /** Current working directory */
  cwd: string;
  /** Additional metrics to display (custom per loop) */
  additionalMetrics?: React.ReactNode;
}

export function Header({
  loopLabel = "ccloop",
  state,
  stateColor,
  heartbeat = "●",
  step,
  status,
  elapsedMs,
  checklist,
  rollingCostUsd = 0,
  rollingTokensIn = 0,
  rollingTokensOut = 0,
  averageCacheHitRate = 0,
  cacheLowStreak = 0,
  cwd,
  additionalMetrics,
}: HeaderProps): React.ReactElement {
  const title = `${loopLabel} · ${state} ${heartbeat}`;

  return (
    <Pane title={title}>
      <Box>
        {step !== undefined && (
          <Text color={stateColor}>step {step}</Text>
        )}
        {status && <Text>  ·  {status}</Text>}
        <Text>  ·  elapsed {formatDuration(elapsedMs)}</Text>
        {checklist && (
          <Text>
            {"  ·  checklist "}
            <Text color={checklist.done === checklist.total ? "green" : undefined}>
              {checklist.done}/{checklist.total}
            </Text>
          </Text>
        )}
        {additionalMetrics}
      </Box>
      <Box>
        <Text>
          cost {formatCost(rollingCostUsd)}  ·  in {formatTokens(rollingTokensIn)} / out {formatTokens(rollingTokensOut)}  ·  cache{" "}
        </Text>
        <Text color={cacheLowStreak >= 3 ? "yellow" : undefined}>
          {formatPct(averageCacheHitRate)}
          {cacheLowStreak >= 3 ? ` (low ${cacheLowStreak}×)` : ""}
        </Text>
      </Box>
      <Text dimColor>{cwd}</Text>
    </Pane>
  );
}
