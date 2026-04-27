import { describe, expect, test } from "bun:test";
import { decideEscalationKey, resetForContinue } from "./escalation.ts";
import { freshState } from "../state/state.ts";
import { asIsoTimestamp, asSha } from "../branded.ts";

describe("decideEscalationKey", () => {
  test("c → continue", () => {
    expect(decideEscalationKey("c", freshState(), null).kind).toBe("continue");
  });
  test("r with sha → revert", () => {
    const r = decideEscalationKey("r", freshState(), asSha("abc"));
    expect(r.kind).toBe("revert");
    if (r.kind === "revert") expect(r.sha).toBe(asSha("abc"));
  });
  test("r without sha → quit", () => {
    expect(decideEscalationKey("r", freshState(), null).kind).toBe("quit");
  });
  test("e → edit_spec", () => {
    expect(decideEscalationKey("e", freshState(), null).kind).toBe("edit_spec");
  });
  test("q → quit", () => {
    expect(decideEscalationKey("q", freshState(), null).kind).toBe("quit");
  });
  test("unknown → quit", () => {
    expect(decideEscalationKey("x", freshState(), null).kind).toBe("quit");
  });
  test("uppercase normalized", () => {
    expect(decideEscalationKey("C", freshState(), null).kind).toBe("continue");
  });
});

describe("resetForContinue", () => {
  test("clears failure state, keeps step number", () => {
    const s = freshState();
    s.consecutive_failures = 5;
    s.no_progress_count = 3;
    s.diff_hashes_recent = ["a", "a", "a"];
    s.escalation = { reason: "x", trail: [], entered_at: asIsoTimestamp("") };
    s.state = "escalated";
    s.current_step = 47;
    resetForContinue(s);
    expect(s.consecutive_failures).toBe(0);
    expect(s.no_progress_count).toBe(0);
    expect(s.diff_hashes_recent).toEqual([]);
    expect(s.escalation).toBeNull();
    expect(s.state as string).toBe("running");
    expect(s.current_step).toBe(47);
  });
});
