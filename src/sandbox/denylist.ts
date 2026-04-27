/**
 * Catastrophic-pattern denylist for Bash invocations per §6.5. Returns
 * a human-readable reason when the command should be denied; null when
 * it's safe to proceed (subject to OS sandbox scoping).
 *
 * Heuristic, not a security boundary. The OS sandbox is the boundary;
 * this just trims the obviously bad cases so the agent course-corrects
 * before we waste a sandbox bounce.
 */

export interface DenyMatch {
  reason: string;
}

const PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[rRf]+[a-zA-Z]*\s+\/(?:\s|$)/, reason: "rm -rf / refused" },
  { re: /\brm\s+-[rRf]+[a-zA-Z]*\s+\/\*(?:\s|$)/, reason: "rm -rf /* refused" },
  { re: /\brm\s+-[rRf]+[a-zA-Z]*\s+~(?:\s|$)/, reason: "rm -rf ~ refused" },
  { re: /\bsudo\b/, reason: "sudo refused (run as the user, not root)" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, reason: "fork bomb refused" },
  { re: /\bdd\s+[^\n]*\bof=\/dev\//, reason: "dd of=/dev/* refused" },
  { re: /\bmkfs\.[a-z0-9]+\s+\/dev\//, reason: "mkfs on raw device refused" },
  { re: /\bchmod\s+-R\s+0+\s+\//, reason: "chmod -R 0 / refused" },
  { re: />\s*\/dev\/sd[a-z]\b/, reason: "writing to raw block device refused" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, reason: "system shutdown commands refused" },
];

export function checkDenylist(command: string): DenyMatch | null {
  for (const { re, reason } of PATTERNS) {
    if (re.test(command)) return { reason };
  }
  return null;
}
