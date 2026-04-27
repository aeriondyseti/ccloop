import { describe, expect, test } from "bun:test";
import { capExcerpt, classifyStep } from "./classify.ts";
import { emptyUsage, type StepResult } from "../sdk/types.ts";
import { asSessionId } from "../branded.ts";

function r(p: Partial<StepResult>): StepResult {
  return {
    subtype: "success", stop_reason: "end_turn", num_turns: 1,
    total_cost_usd: 0, duration_ms: 0, usage: emptyUsage(),
    session_id: asSessionId(""), final_text: "", errors: [], ...p,
  };
}

describe("classifyStep", () => {
  test("success+end_turn", () => {
    expect(classifyStep(r({})).outcome).toBe("success");
  });
  test("success+pause_turn is success", () => {
    expect(classifyStep(r({ stop_reason: "pause_turn" })).outcome).toBe("success");
  });
  test("success+max_tokens is success", () => {
    expect(classifyStep(r({ stop_reason: "max_tokens" })).outcome).toBe("success");
  });
  test("success+refusal is failure", () => {
    expect(classifyStep(r({ stop_reason: "refusal" })))
      .toMatchObject({ outcome: "failure", category: "refusal" });
  });
  test("error_max_turns", () => {
    expect(classifyStep(r({ subtype: "error_max_turns", num_turns: 50 })))
      .toMatchObject({ outcome: "failure", category: "max_turns", excerpt: "hit maxTurns (50)" });
  });
  test("error_during_execution joins errors", () => {
    expect(classifyStep(r({ subtype: "error_during_execution", errors: ["a", "b"] })))
      .toMatchObject({ outcome: "failure", category: "sdk", excerpt: "a\nb" });
  });
  test("error_during_execution falls back when errors empty", () => {
    expect(classifyStep(r({ subtype: "error_during_execution", errors: [] })))
      .toMatchObject({ outcome: "failure", category: "sdk", excerpt: "execution error" });
  });
  test("error_max_structured_output_retries", () => {
    expect(classifyStep(r({ subtype: "error_max_structured_output_retries" })))
      .toMatchObject({ outcome: "failure", category: "structured_output" });
  });
  test("error_max_budget_usd", () => {
    expect(classifyStep(r({ subtype: "error_max_budget_usd" })))
      .toMatchObject({ outcome: "failure", category: "max_budget" });
  });
});

describe("capExcerpt", () => {
  test("under cap returns input verbatim", () => {
    expect(capExcerpt("short")).toBe("short");
  });
  test("at cap returns input verbatim", () => {
    const s = "x".repeat(1024);
    expect(capExcerpt(s)).toBe(s);
  });
  test("over cap truncates and appends ellipsis", () => {
    const s = "x".repeat(1100);
    const out = capExcerpt(s);
    expect(out.length).toBe(1024);
    expect(out.endsWith("…")).toBe(true);
  });
  test("custom cap honoured", () => {
    expect(capExcerpt("abcdef", 4)).toBe("abc…");
  });
});
