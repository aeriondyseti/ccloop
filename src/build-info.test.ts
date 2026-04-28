import { describe, expect, test } from "bun:test";
import { isDevBuild, IS_DEV_BUILD, VERSION } from "./build-info.ts";

describe("isDevBuild predicate", () => {
  test("clean version + no git → prod", () => {
    expect(isDevBuild("1.0.0", false)).toBe(false);
    expect(isDevBuild("0.5.2", false)).toBe(false);
  });

  test("prerelease suffix → dev (matches CI's -dev.<run> suffix)", () => {
    expect(isDevBuild("1.0.0-dev.42", false)).toBe(true);
    expect(isDevBuild("1.0.0-rc.1", false)).toBe(true);
    expect(isDevBuild("0.0.1-pre", false)).toBe(true);
  });

  test("adjacent .git/ → dev (catches local working trees)", () => {
    expect(isDevBuild("1.0.0", true)).toBe(true);
    expect(isDevBuild("0.5.2", true)).toBe(true);
  });

  test("either signal is sufficient", () => {
    expect(isDevBuild("1.0.0-dev.1", true)).toBe(true);
  });
});

describe("module constants", () => {
  test("VERSION is a non-empty string", () => {
    expect(VERSION).toBeTruthy();
    expect(typeof VERSION).toBe("string");
  });

  test("IS_DEV_BUILD is true when running tests from the working tree", () => {
    // Tests always run from a checkout that has .git/. If this ever
    // fails it means someone packaged the test suite into a tarball.
    expect(IS_DEV_BUILD).toBe(true);
  });
});
