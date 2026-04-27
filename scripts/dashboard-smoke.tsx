#!/usr/bin/env bun
/**
 * Smoke render the Dashboard with stub data so we can eyeball the
 * new layout. Exits after 1s.
 *
 *   bun scripts/dashboard-smoke.tsx
 */
import React from "react";
import { render } from "ink";
import { Dashboard } from "../src/tui/Dashboard.tsx";
import { EMPTY_VIEW, type TuiViewModel } from "../src/tui/types.ts";

const view: TuiViewModel = {
  ...EMPTY_VIEW,
  state: "RUNNING",
  step: 12,
  runId: "0ab68e32-ef8c-4426-b997-3263db3b8cfc",
  startedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
  cwd: "/Users/kevinwhiteside/Personal/Development/scratch/md-to-text",
  elapsedMs: 14 * 60 * 1000 + 32 * 1000,
  rollingCostUsd: 1.04,
  rollingTokensIn: 8100,
  rollingTokensOut: 5000,
  averageCacheHitRate: 0.995,
  usage: {
    five_hour: { utilization: 53.2, resets_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
    seven_day: { utilization: 12.1, resets_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString() },
  },
  nowContent: [
    { kind: "turn_start", turn: 8, ts: new Date().toISOString() },
    { kind: "assistant_text", ts: new Date().toISOString(),
      text: "I'll run the tests now and verify the coverage requirement is met before creating DONE.md. Based on the prior step's regex fix to the blockquote handler, all 23 tests should pass." },
    { kind: "tool_use", tool: "Bash", summary: "bun test --coverage", ts: new Date().toISOString() },
  ],
  logContent: [
    "20:14:31  step 11 started",
    "20:16:52  step 11 ✓ 2m20s · $0.45 · 260c92a · feat: blockquote regex",
    "20:18:03  step 12 started · resumed session 5b3a8403",
  ],
  focus: "now",
  heartbeat: "●",
  controlsHint: "tab focus · ↑↓ scroll · ⇞⇟ page · g/G top/bot · ctrl-c stop",
};

const ink = render(React.createElement(Dashboard, { view }));
setTimeout(() => {
  ink.unmount();
  process.exit(0);
}, 1000);
