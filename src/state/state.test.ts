import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATE_SCHEMA_VERSION,
  StateError,
  freshState,
  readState,
  validateState,
  writeState,
} from "./state.ts";

describe("state round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("freshState shape", () => {
    const s = freshState();
    expect(s.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(s.current_step).toBe(1);
    expect(s.state).toBe("running");
    expect(s.session_id).toBe(null);
  });

  test("write then read returns equal state", async () => {
    const path = join(dir, "state.json");
    const s = freshState();
    await writeState(path, s);
    const r = await readState(path);
    expect(r).toEqual(s);
  });

  test("readState returns null when missing", async () => {
    const r = await readState(join(dir, "nope.json"));
    expect(r).toBe(null);
  });

  test("validateState rejects future schema_version", () => {
    expect(() =>
      validateState({ ...freshState(), schema_version: 999 }),
    ).toThrow(StateError);
  });

  test("validateState rejects missing fields", () => {
    expect(() => validateState({ schema_version: 1 })).toThrow(StateError);
  });

  test("validateState rejects unknown state value", () => {
    const s = { ...freshState(), state: "wat" };
    expect(() => validateState(s)).toThrow(/state.*must be one of/);
  });

  test("validateState rejects state=paused without pause info", () => {
    const s = { ...freshState(), state: "paused", pause: null };
    expect(() => validateState(s)).toThrow(/state=paused but `pause` is null/);
  });

  test("validateState rejects state=escalated without escalation info", () => {
    const s = { ...freshState(), state: "escalated", escalation: null };
    expect(() => validateState(s)).toThrow(/state=escalated but `escalation` is null/);
  });

  test("validateState rejects NaN / Infinity in numeric fields", () => {
    // typeof NaN === "number" — a hand-edited state.json with NaN
    // here would otherwise silently pass and produce nonsense
    // comparisons in the loop driver.
    expect(() =>
      validateState({ ...freshState(), current_step: Number.NaN }),
    ).toThrow(/must be a finite number/);
    expect(() =>
      validateState({ ...freshState(), wall_clock_ms: Number.POSITIVE_INFINITY }),
    ).toThrow(/must be a finite number/);
  });

  test("write is atomic (no .tmp left behind)", async () => {
    const path = join(dir, "state.json");
    await writeState(path, freshState());
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text).run_id).toBeTruthy();
    // The .tmp variant should not exist
    const tmpPath = `${path}.tmp.${process.pid}`;
    await expect(readFile(tmpPath, "utf8")).rejects.toThrow();
  });
});
