import { describe, expect, test } from "bun:test";
import { checkDenylist } from "./denylist.ts";
import { wrapBash, bwrapCommand, sandboxExecCommand } from "./wrap.ts";
import { makeApprover } from "./approver.ts";

describe("denylist", () => {
  test("rm -rf / blocked", () => {
    expect(checkDenylist("rm -rf /")).not.toBe(null);
    expect(checkDenylist("rm -rf /*")).not.toBe(null);
  });
  test("sudo blocked", () => {
    expect(checkDenylist("sudo apt install foo")).not.toBe(null);
  });
  test("fork bomb blocked", () => {
    expect(checkDenylist(":(){:|:&};:")).not.toBe(null);
  });
  test("normal commands allowed", () => {
    expect(checkDenylist("ls -la")).toBe(null);
    expect(checkDenylist("rm -rf node_modules")).toBe(null);
    expect(checkDenylist("git commit -m x")).toBe(null);
  });
});

describe("wrapBash", () => {
  test("linux without bwrap → unavailable", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "linux", hasBin: () => false,
    });
    expect(r.kind).toBe("unavailable");
  });

  test("linux with bwrap → wrap", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "linux",
      hasBin: (p) => p === "/usr/bin/bwrap",
    });
    expect(r.kind).toBe("wrap");
    if (r.kind === "wrap") {
      expect(r.command).toContain("bwrap");
      expect(r.command).toContain("--unshare-net");
      expect(r.command).toContain("'ls'");
    }
  });

  test("darwin → wrap with sandbox-exec", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "darwin",
    });
    expect(r.kind).toBe("wrap");
    if (r.kind === "wrap") expect(r.command).toContain("sandbox-exec");
  });

  test("other → passthrough", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "other",
    });
    expect(r.kind).toBe("passthrough");
  });

  test("bwrap quotes safely", () => {
    const cmd = bwrapCommand("/usr/bin/bwrap", "/p", "echo 'hi'");
    expect(cmd).toContain("--bind '/p' '/p'");
  });

  test("sandbox-exec profile mentions cwd", () => {
    const cmd = sandboxExecCommand("/path/to/proj", "echo hi");
    expect(cmd).toContain("/path/to/proj");
    expect(cmd).toContain("deny file-write*");
  });
});

describe("makeApprover", () => {
  test("yolo allows everything unchanged", async () => {
    const approve = makeApprover({ yoloMode: true, cwd: "/x" });
    const r = await approve("Bash", { command: "rm -rf /" });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") expect(r.updatedInput.command).toBe("rm -rf /");
  });

  test("non-yolo Bash gets wrapped on linux+bwrap", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux",
      hasBin: (p) => p === "/usr/bin/bwrap",
    });
    const r = await approve("Bash", { command: "ls" });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") {
      expect(String(r.updatedInput.command)).toContain("bwrap");
    }
  });

  test("non-yolo Bash blocked by denylist", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux",
      hasBin: () => true,
    });
    const r = await approve("Bash", { command: "sudo halt" });
    expect(r.behavior).toBe("deny");
  });

  test("non-bash tools allowed unchanged", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux", hasBin: () => true,
    });
    const r = await approve("Read", { path: "/x/foo" });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") expect(r.updatedInput.path).toBe("/x/foo");
  });

  test("missing bwrap on linux denies", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux", hasBin: () => false,
    });
    const r = await approve("Bash", { command: "ls" });
    expect(r.behavior).toBe("deny");
  });
});
