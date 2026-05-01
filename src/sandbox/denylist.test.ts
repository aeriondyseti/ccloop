import { describe, expect, test } from "bun:test";
import { checkDenylist } from "./denylist.ts";

describe("checkDenylist", () => {
  test("safe commands pass", () => {
    expect(checkDenylist("ls -la")).toBeNull();
    expect(checkDenylist("bun test")).toBeNull();
    expect(checkDenylist("git status")).toBeNull();
    expect(checkDenylist("git push origin feature/x")).toBeNull();
  });

  test("rm -rf / patterns refused", () => {
    expect(checkDenylist("rm -rf /")?.reason).toMatch(/rm -rf/);
    expect(checkDenylist("rm -rf /*")?.reason).toMatch(/rm -rf/);
    expect(checkDenylist("rm -rf ~")?.reason).toMatch(/rm -rf/);
  });

  test("sudo refused", () => {
    expect(checkDenylist("sudo apt-get update")?.reason).toMatch(/sudo/);
  });

  test("system shutdown refused", () => {
    expect(checkDenylist("shutdown -h now")?.reason).toMatch(/shutdown/);
    expect(checkDenylist("reboot")?.reason).toMatch(/shutdown/);
  });

  test("git force-push refused (multiple shapes)", () => {
    // Long flag.
    expect(checkDenylist("git push --force origin main")?.reason).toMatch(/force-push/);
    // Short flag.
    expect(checkDenylist("git push -f origin main")?.reason).toMatch(/force-push/);
    // --force-with-lease still rewrites remote and counts.
    expect(checkDenylist("git push --force-with-lease origin main")?.reason).toMatch(/force-push/);
    // +ref shorthand.
    expect(checkDenylist("git push origin +main")?.reason).toMatch(/force-push/);
  });

  test("regular git push not refused", () => {
    expect(checkDenylist("git push")).toBeNull();
    expect(checkDenylist("git push origin main")).toBeNull();
    expect(checkDenylist("git push -u origin feature/x")).toBeNull();
  });

  test("package publish refused across managers", () => {
    expect(checkDenylist("npm publish")?.reason).toMatch(/registry/);
    expect(checkDenylist("yarn publish")?.reason).toMatch(/registry/);
    expect(checkDenylist("pnpm publish")?.reason).toMatch(/registry/);
    expect(checkDenylist("bun publish")?.reason).toMatch(/registry/);
    expect(checkDenylist("npm publish --tag dev")?.reason).toMatch(/registry/);
  });

  test("npm install (similar shape) not refused", () => {
    expect(checkDenylist("npm install")).toBeNull();
    expect(checkDenylist("bun install")).toBeNull();
  });
});
