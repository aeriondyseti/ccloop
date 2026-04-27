import { describe, expect, test } from "bun:test";
import { EventBus } from "./eventBus.ts";

describe("EventBus", () => {
  test("delivers emitted events to all subscribers in order", () => {
    const bus = new EventBus<number>();
    const seen: number[] = [];
    bus.subscribe((n) => seen.push(n * 10));
    bus.subscribe((n) => seen.push(n * 100));
    bus.emit(1);
    bus.emit(2);
    expect(seen).toEqual([10, 100, 20, 200]);
  });

  test("unsubscribe stops further delivery for that listener", () => {
    const bus = new EventBus<string>();
    const a: string[] = [];
    const b: string[] = [];
    const off = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.emit("first");
    off();
    bus.emit("second");
    expect(a).toEqual(["first"]);
    expect(b).toEqual(["first", "second"]);
  });

  test("a throwing subscriber does not break the emit", () => {
    const bus = new EventBus<number>();
    const seen: number[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((n) => seen.push(n));
    expect(() => bus.emit(7)).not.toThrow();
    expect(seen).toEqual([7]);
  });
});
