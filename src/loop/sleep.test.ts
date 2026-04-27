import { describe, expect, test } from "bun:test";
import { abortableSleep } from "./sleep.ts";

describe("abortableSleep", () => {
  test("resolves after ms", async () => {
    const start = Date.now();
    await abortableSleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
  test("zero ms returns immediately", async () => {
    const start = Date.now();
    await abortableSleep(0);
    expect(Date.now() - start).toBeLessThan(10);
  });
  test("aborted signal returns immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await abortableSleep(1000, ac.signal);
    expect(Date.now() - start).toBeLessThan(20);
  });
  test("abort during sleep wakes early", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const start = Date.now();
    await abortableSleep(2000, ac.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });
});
