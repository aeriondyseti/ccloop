import { describe, expect, test } from "bun:test";
import { createPauseGate } from "./pauseGate.ts";

describe("createPauseGate", () => {
  test("starts unpaused", () => {
    const g = createPauseGate();
    expect(g.isPaused()).toBe(false);
  });

  test("toggle flips and returns the new state", () => {
    const g = createPauseGate();
    expect(g.toggle()).toBe(true);
    expect(g.isPaused()).toBe(true);
    expect(g.toggle()).toBe(false);
    expect(g.isPaused()).toBe(false);
  });

  test("waitUntilUnpaused resolves immediately when not paused", async () => {
    const g = createPauseGate();
    const ac = new AbortController();
    await g.waitUntilUnpaused(ac.signal);
    // If we got here without hanging, pass.
    expect(g.isPaused()).toBe(false);
  });

  test("waitUntilUnpaused resolves when toggled off", async () => {
    const g = createPauseGate();
    g.toggle(); // pause
    const ac = new AbortController();
    let resolved = false;
    const p = g.waitUntilUnpaused(ac.signal).then(() => { resolved = true; });
    // Briefly yield to confirm not yet resolved.
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    g.toggle(); // unpause
    await p;
    expect(resolved).toBe(true);
  });

  test("waitUntilUnpaused resolves when signal aborts", async () => {
    const g = createPauseGate();
    g.toggle();
    const ac = new AbortController();
    let resolved = false;
    const p = g.waitUntilUnpaused(ac.signal).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    ac.abort();
    await p;
    expect(resolved).toBe(true);
    // Gate is still paused — abort doesn't unpause it.
    expect(g.isPaused()).toBe(true);
  });

  test("waitUntilUnpaused returns immediately if signal already aborted", async () => {
    const g = createPauseGate();
    g.toggle();
    const ac = new AbortController();
    ac.abort();
    await g.waitUntilUnpaused(ac.signal);
    expect(g.isPaused()).toBe(true);
  });

  test("multiple concurrent waiters all resolve on unpause", async () => {
    const g = createPauseGate();
    g.toggle();
    const ac = new AbortController();
    const counts = { resolved: 0 };
    const p1 = g.waitUntilUnpaused(ac.signal).then(() => { counts.resolved++; });
    const p2 = g.waitUntilUnpaused(ac.signal).then(() => { counts.resolved++; });
    const p3 = g.waitUntilUnpaused(ac.signal).then(() => { counts.resolved++; });
    g.toggle();
    await Promise.all([p1, p2, p3]);
    expect(counts.resolved).toBe(3);
  });

  test("onChange listener fires on toggle and unsubscribe stops it", () => {
    const g = createPauseGate();
    let count = 0;
    const unsub = g.onChange(() => { count++; });
    g.toggle();
    expect(count).toBe(1);
    g.toggle();
    expect(count).toBe(2);
    unsub();
    g.toggle();
    expect(count).toBe(2);
  });

  test("listener errors don't break toggle", () => {
    const g = createPauseGate();
    g.onChange(() => { throw new Error("boom"); });
    expect(() => g.toggle()).not.toThrow();
    expect(g.isPaused()).toBe(true);
  });
});
