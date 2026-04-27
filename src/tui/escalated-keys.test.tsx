import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Dashboard } from "./Dashboard.tsx";
import { EMPTY_VIEW } from "./types.ts";
import type { TuiViewModel } from "./types.ts";

function escalatedView(): TuiViewModel {
  return {
    ...EMPTY_VIEW,
    state: "ESCALATED",
    cwd: "/tmp",
    runId: "r" as TuiViewModel["runId"],
    step: 1,
    escalation: { reason: "test" },
  };
}

describe("ESCALATED menu keys", () => {
  test("c reaches onMenuKey", async () => {
    const presses: string[] = [];
    const view = escalatedView();
    const { stdin } = render(
      <Dashboard view={view} onMenuKey={(k) => presses.push(k)} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 10));
    expect(presses).toEqual(["c"]);
  });

  test("q reaches onMenuKey", async () => {
    const presses: string[] = [];
    const view = escalatedView();
    const { stdin } = render(
      <Dashboard view={view} onMenuKey={(k) => presses.push(k)} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 10));
    expect(presses).toEqual(["q"]);
  });

  test("c works after Running→Escalated transition (production sequence)", async () => {
    const presses: string[] = [];
    // Production sequence: Dashboard mounts in RUNNING with no onMenuKey,
    // gets many heartbeat rerenders, then transitions to ESCALATED with
    // onMenuKey set in one rerender (via run.ts's readMenuKey).
    const running: TuiViewModel = {
      ...EMPTY_VIEW,
      state: "RUNNING",
      cwd: "/tmp",
      runId: "r" as TuiViewModel["runId"],
      step: 1,
    };
    const { stdin, rerender } = render(
      <Dashboard view={running} onMenuKey={undefined} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    // Several heartbeat rerenders while RUNNING with no handler.
    for (let i = 0; i < 3; i++) {
      rerender(<Dashboard view={running} onMenuKey={undefined} />);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Transition: ESCALATED + onMenuKey set.
    const escalated = escalatedView();
    rerender(
      <Dashboard view={escalated} onMenuKey={(k) => presses.push(k)} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 10));
    expect(presses).toEqual(["c"]);
  });
});
