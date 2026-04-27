import { describe, expect, test } from "bun:test";
import { decideMatrix } from "./matrix.ts";

describe("decideMatrix", () => {
  test("--continue without .ccloop refused", () => {
    const r = decideMatrix({ hasCcloopDir: false, hasSpec: true, cont: true });
    expect(r.kind).toBe("refuse");
  });
  test("--continue with .ccloop+SPEC resumes silently", () => {
    expect(decideMatrix({ hasCcloopDir: true, hasSpec: true, cont: true }).kind)
      .toBe("resume_no_prompt");
  });
  test("both present, no flag → confirm-resume", () => {
    expect(decideMatrix({ hasCcloopDir: true, hasSpec: true, cont: false }).kind)
      .toBe("resume_after_confirm");
  });
  test("only SPEC → start fresh", () => {
    expect(decideMatrix({ hasCcloopDir: false, hasSpec: true, cont: false }).kind)
      .toBe("start_fresh");
  });
  test("nothing → scaffold prompt", () => {
    expect(decideMatrix({ hasCcloopDir: false, hasSpec: false, cont: false }).kind)
      .toBe("scaffold_or_exit");
  });
  test(".ccloop without SPEC → refuse", () => {
    const r = decideMatrix({ hasCcloopDir: true, hasSpec: false, cont: false });
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toMatch(/SPEC\.md/);
  });
  test("--continue with .ccloop but no SPEC → refuse", () => {
    const r = decideMatrix({ hasCcloopDir: true, hasSpec: false, cont: true });
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toMatch(/SPEC\.md/);
  });
});
