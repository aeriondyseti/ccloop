import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Dashboard, type MenuKey } from "./Dashboard.tsx";
import { EMPTY_VIEW } from "./types.ts";
import type { TuiViewModel } from "./types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function viewIn(state: TuiViewModel["state"]): TuiViewModel {
  const v = {
    ...EMPTY_VIEW,
    state,
    cwd: "/tmp",
    runId: "r" as TuiViewModel["runId"],
    step: 1,
  };
  if (state === "ESCALATED") v.escalation = { reason: "test" };
  return v;
}

/**
 * Reproduces run.ts's wiring: an initial render with no onMenuKey,
 * a heartbeat tick that rerenders every TUI_TICK_MS with whatever
 * menuKeyHandler is currently set, and a readMenuKey call that
 * sets the handler and forces an immediate rerender.
 */
describe("run.ts wiring against Dashboard", () => {
  test("c reaches handler after escalation through tick + readMenuKey", async () => {
    let view = viewIn("RUNNING");
    let menuKeyHandler: ((k: MenuKey) => void) | null = null;
    const onInterrupt = (): void => {};

    const { stdin, rerender } = render(
      <Dashboard view={view} onInterrupt={onInterrupt} />,
    );

    // Tick: rerenders every "tick" with current menuKeyHandler.
    const tick = setInterval(() => {
      rerender(
        <Dashboard
          view={view}
          onMenuKey={menuKeyHandler ?? undefined}
          onInterrupt={onInterrupt}
        />,
      );
    }, 50);

    await sleep(120); // a few ticks while RUNNING

    // Simulate orchestrator escalating: state.state mutates silently;
    // run.ts's handleEscalation calls readMenuKey which sets the
    // handler, rebuilds view, and forces a rerender.
    const presses: MenuKey[] = [];
    const result = new Promise<MenuKey>((resolve) => {
      menuKeyHandler = (k) => {
        presses.push(k);
        resolve(k);
      };
      view = viewIn("ESCALATED"); // <-- like buildView with new state
      rerender(
        <Dashboard
          view={view}
          onMenuKey={menuKeyHandler}
          onInterrupt={onInterrupt}
        />,
      );
    });

    await sleep(50); // let the forced-rerender's effects settle
    stdin.write("c");

    const k = await Promise.race([
      result,
      sleep(500).then(() => "TIMEOUT" as const),
    ]);

    clearInterval(tick);
    expect(k).toBe("c");
    expect(presses).toEqual(["c"]);
  });
});
