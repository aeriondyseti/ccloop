/**
 * Shared usage pane showing API rate limits and utilization.
 */

import { Text } from "ink";
import React from "react";
import { Pane } from "./components.tsx";
import { formatBar, formatCountdown } from "../format.ts";
import type { UsageSnapshot } from "../../usage/client.ts";

export interface UsagePaneProps {
  usage: UsageSnapshot | null;
}

export function UsagePane({ usage }: UsagePaneProps): React.ReactElement {
  if (!usage) {
    return (
      <Pane title="usage">
        <Text dimColor>(no data)</Text>
      </Pane>
    );
  }
  const { five_hour, seven_day } = usage;
  return (
    <Pane title="usage">
      <Text>5h    {formatBar(five_hour.utilization)} {five_hour.utilization.toFixed(1)}%  resets {formatCountdown(five_hour.resets_at)}</Text>
      <Text>week  {formatBar(seven_day.utilization)} {seven_day.utilization.toFixed(1)}%  resets {formatCountdown(seven_day.resets_at)}</Text>
    </Pane>
  );
}
