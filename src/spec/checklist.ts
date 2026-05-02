/**
 * Count `- [ ]` and `- [x]` checklist items in a SPEC.md so the
 * dashboard and wake-up recap can surface "12/47 done" — the
 * single most useful overnight-progress signal that doesn't
 * require an LLM judgement call.
 *
 * Heuristic, not a parser. Matches the GitHub-flavored markdown
 * task-list convention: a list bullet (`-`, `*`, `+`, or numbered
 * `1.`) followed by `[ ]` or `[x]` (case-insensitive). Any line
 * that doesn't match contributes nothing — code fences and prose
 * `[x] some text` snippets in the body are ignored because the
 * regex requires the bullet prefix.
 */

export interface ChecklistProgress {
  done: number;
  total: number;
}

const ITEM_RE =
  /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[( |x|X)\][ \t]/;

export function parseChecklist(text: string): ChecklistProgress {
  if (!text) return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  let inFence = false;
  for (const rawLine of text.split("\n")) {
    // Skip fenced code blocks — `[x] foo` inside a code block is
    // documentation about the convention, not a real item.
    if (/^[ \t]*`{3,}/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ITEM_RE.exec(rawLine);
    if (!m) continue;
    total += 1;
    if (m[1] !== " ") done += 1;
  }
  return { done, total };
}
