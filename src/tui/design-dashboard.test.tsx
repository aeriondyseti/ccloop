/**
 * Smoke + interaction tests for DesignDashboard.
 *
 * The bridge is a small synchronous store, so we can drive it from
 * tests without any React/Ink trickery. We assert that:
 *  - initial mount shows transcript and draft headers
 *  - draft updates render in the right pane
 *  - assistant text and tool uses appear in the left pane
 *  - the ask_user widget renders when bridge.adapter.askUser() is in flight
 *  - confirm widget responds to y/n
 *  - input widget accepts typed characters and submits on Enter
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { DesignDashboard } from "./DesignDashboard.tsx";
import { createDesignTuiBridge } from "./design-bridge.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rerenderTick(rerender: (el: React.ReactElement) => void, el: React.ReactElement): void {
  rerender(el);
}

let activeUnmount: (() => void) | null = null;
afterEach(() => {
  if (activeUnmount) {
    activeUnmount();
    activeUnmount = null;
  }
});

describe("DesignDashboard", () => {
  test("renders the two-pane layout with default state", () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp/proj" />,
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ccloop design");
    expect(frame).toContain("transcript");
    expect(frame).toContain("spec.draft.md");
    expect(frame).toContain("/tmp/proj");
    expect(frame).toContain("DESIGNING");
  });

  test("draftUpdated renders into the right pane", () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, rerender, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp" />,
    );
    activeUnmount = unmount;
    bridge.adapter.draftUpdated("# Hello\n\nbody line");
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(lastFrame() ?? "").toContain("# Hello");
    expect(lastFrame() ?? "").toContain("body line");
  });

  test("assistant text and tool uses appear in the transcript", () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, rerender, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp" />,
    );
    activeUnmount = unmount;
    bridge.adapter.showAssistantText("hi from the agent");
    bridge.adapter.showToolUse("Read", "SPEC.md");
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi from the agent");
    expect(frame).toContain("Read");
  });

  test("ask_user widget renders when an ask is pending", async () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, rerender, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp" />,
    );
    activeUnmount = unmount;
    const pending = bridge.adapter.askUser({
      question: "Pick one",
      options: [
        { label: "Alpha", description: "the first" },
        { label: "Beta", description: "the second" },
      ],
    });
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(lastFrame() ?? "").toContain("Pick one");
    expect(lastFrame() ?? "").toContain("Alpha");
    expect(lastFrame() ?? "").toContain("Beta");
    expect(lastFrame() ?? "").toContain("ASKING");

    bridge.submitAsk({ selected: ["Alpha"] });
    const result = await pending;
    expect(result.selected).toEqual(["Alpha"]);
  });

  test("confirm widget surfaces the question and ASKING state", async () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, rerender, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp" />,
    );
    activeUnmount = unmount;
    const promise = bridge.adapter.confirm("Promote draft?", true);
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(lastFrame() ?? "").toContain("Promote draft?");
    expect(lastFrame() ?? "").toContain("CONFIRMING");
    bridge.submitConfirm(true);
    expect(await promise).toBe(true);
  });

  test("input widget accepts typed characters and submits via stdin Enter", async () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, stdin, rerender, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp" />,
    );
    activeUnmount = unmount;
    const next = bridge.adapter.getNextInput();
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(lastFrame() ?? "").toContain("WAITING");

    stdin.write("hi");
    await sleep(10);
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(lastFrame() ?? "").toContain("hi");

    stdin.write("\r");
    const line = await next;
    expect(line).toBe("hi");
  });

  test("Tab cycles focus between transcript and draft", async () => {
    const bridge = createDesignTuiBridge();
    const { lastFrame, stdin, rerender, unmount } = render(
      <DesignDashboard bridge={bridge} cwd="/tmp" />,
    );
    activeUnmount = unmount;
    // Frame text gets line-wrapped at the pane width, so flatten
    // whitespace before searching for the title-right hint phrases.
    const flatten = (s: string) => s.replace(/\s+/g, " ");
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(flatten(lastFrame() ?? "")).toContain("tab to draft");

    stdin.write("\t");
    await sleep(10);
    rerenderTick(rerender, <DesignDashboard bridge={bridge} cwd="/tmp" />);
    expect(flatten(lastFrame() ?? "")).toContain("tab to transcript");
  });
});
