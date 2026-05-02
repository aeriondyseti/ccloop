import { describe, expect, test } from "bun:test";
import { parseChecklist } from "./checklist.ts";

describe("parseChecklist", () => {
  test("empty input → zero", () => {
    expect(parseChecklist("")).toEqual({ done: 0, total: 0 });
  });

  test("counts mixed open/done items", () => {
    const text = `# Spec\n\n- [ ] one\n- [x] two\n- [X] three\n- [ ] four`;
    expect(parseChecklist(text)).toEqual({ done: 2, total: 4 });
  });

  test("supports *, +, and numbered bullets", () => {
    const text = `* [x] a\n+ [ ] b\n1. [x] c\n2) [ ] d`;
    expect(parseChecklist(text)).toEqual({ done: 2, total: 4 });
  });

  test("ignores prose-embedded [x] without bullet prefix", () => {
    const text = `Some prose with [x] inline\nMore [ ] text.`;
    expect(parseChecklist(text)).toEqual({ done: 0, total: 0 });
  });

  test("ignores items inside fenced code blocks", () => {
    const text = "explanation:\n```\n- [x] documentation example\n- [ ] another\n```\n- [ ] real item";
    expect(parseChecklist(text)).toEqual({ done: 0, total: 1 });
  });

  test("indented sub-items still count", () => {
    const text = `- [x] parent\n  - [ ] child\n  - [x] sibling`;
    expect(parseChecklist(text)).toEqual({ done: 2, total: 3 });
  });
});
