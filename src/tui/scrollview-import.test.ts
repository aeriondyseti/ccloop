import { describe, expect, test } from "bun:test";
import * as scrollView from "ink-scroll-view";

describe("ink-scroll-view import", () => {
  test("ScrollView export is a forwardRef component", () => {
    expect(scrollView.ScrollView).toBeDefined();
    expect(typeof scrollView.ScrollView).toBe("object");
  });
});
