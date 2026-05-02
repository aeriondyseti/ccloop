/**
 * Derive a one-line auto-commit subject from the final assistant text.
 * Per §14.6: first non-blank line, stripped of leading markdown noise,
 * capped at 72 visual columns. Falls back to a generic subject when
 * the text is unusable.
 */
import { truncateToWidth } from "../util/width.ts";

export function deriveCommitSubject(finalText: string, step: number): string {
  const fallback = `ccloop step ${step}`;
  if (!finalText) return fallback;

  for (const rawLine of finalText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const cleaned = stripMarkdownLead(line);
    if (cleaned.length === 0) continue;
    return truncateToWidth(cleaned, 72);
  }
  return fallback;
}

function stripMarkdownLead(line: string): string {
  // Drop heading hashes, blockquote markers, list bullets, code fences.
  let s = line;
  s = s.replace(/^#{1,6}\s+/, "");
  s = s.replace(/^>\s+/, "");
  s = s.replace(/^[-*+]\s+/, "");
  s = s.replace(/^\d+[.)]\s+/, "");
  s = s.replace(/^`{3,}.*$/, "");
  // Drop bold/italic emphasis around the whole string.
  s = s.replace(/^\*\*(.*)\*\*$/, "$1");
  s = s.replace(/^_(.*)_$/, "$1");
  return s.trim();
}

