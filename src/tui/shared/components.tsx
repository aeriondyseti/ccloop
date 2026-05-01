/**
 * Shared presentational components for TUI layouts.
 */

import { Box, Text } from "ink";
import React from "react";
import { useTerminalSize } from "./hooks.tsx";

// ===== Frame: viewport-sized container =====

/** Sizes the outer container to the actual terminal dimensions so
 *  flex children have a real viewport to lay out into. Without this,
 *  the dashboard renders at intrinsic content height: it doesn't fill
 *  the screen on first paint, flexGrow is a no-op so panes squeeze
 *  out their borders, and successive repaints scroll-flicker because
 *  each frame is a fresh block at the cursor position rather than an
 *  in-place redraw of a known viewport. */
export function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  const { rows, cols } = useTerminalSize();
  return (
    <Box width={cols} height={rows} flexDirection="column">
      {children}
    </Box>
  );
}

// ===== Pane: bordered container with title =====

type PaneRole = "static" | "focusable";

export interface PaneProps {
  title: string;
  role?: PaneRole;
  focused?: boolean;
  titleRight?: string;
  flexGrow?: number;
  height?: number;
  children?: React.ReactNode;
}

export function Pane({
  title, role = "static", focused = false,
  titleRight, flexGrow, height, children,
}: PaneProps): React.ReactElement {
  const isHot = role === "focusable" && focused;
  const borderStyle = isHot ? "double" : "round";
  const borderColor = isHot
    ? "cyan"
    : (role === "focusable" ? "gray" : undefined);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      flexGrow={flexGrow}
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      <Box>
        <Text bold color={isHot ? "cyan" : undefined}>{title}</Text>
        {titleRight ? (
          <>
            <Box flexGrow={1} />
            <Text dimColor>{titleRight}</Text>
          </>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

// ===== Controls: hint bar =====

export function Controls({ hint }: { hint: string }): React.ReactElement {
  return <Text dimColor>{hint}</Text>;
}
