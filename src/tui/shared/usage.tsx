/**
 * Shared usage pane showing API rate limits and utilization.
 */

import { Text } from "ink";
import React from "react";
import { Pane } from "./components.tsx";
import { formatBar, formatCountdown, formatTokens } from "../format.ts";
import type { UsageSnapshot } from "../../usage/client.ts";

export interface UsagePaneProps {
  usage: UsageSnapshot | null;
  /** Most recent step's input-side context tokens; null hides the row. */
  contextTokens?: number;
  /** Denominator for the context bar — model context window. */
  contextWindowTokens?: number;
}

export function UsagePane({
  usage, contextTokens, contextWindowTokens,
}: UsagePaneProps): React.ReactElement {
  const contextRow = renderContextRow(contextTokens, contextWindowTokens);
  if (!usage) {
    return (
      <Pane title="usage">
        <Text dimColor>(no data)</Text>
        {contextRow}
      </Pane>
    );
  }
  const { five_hour, seven_day } = usage;
  return (
    <Pane title="usage">
      <Text>5h      {formatBar(five_hour.utilization)} {five_hour.utilization.toFixed(1)}%  resets {formatCountdown(five_hour.resets_at)}</Text>
      <Text>week    {formatBar(seven_day.utilization)} {seven_day.utilization.toFixed(1)}%  resets {formatCountdown(seven_day.resets_at)}</Text>
      {contextRow}
    </Pane>
  );
}

function renderContextRow(
  tokens: number | undefined,
  window: number | undefined,
): React.ReactElement | null {
  if (tokens === undefined || !window) return null;
  const pct = (tokens / window) * 100;
  // Red ≥ 90% — auto-rotate triggers reactively on overflow, so a
  // visible warning band gives the operator time to intervene.
  const color = pct >= 90 ? "red" : pct >= 75 ? "yellow" : undefined;
  return (
    <Text color={color}>
      context {formatBar(pct)} {pct.toFixed(1)}%  {formatTokens(tokens)} / {formatTokens(window)}
    </Text>
  );
}
