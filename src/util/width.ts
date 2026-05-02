/**
 * Width-aware string utilities. Used wherever ccloop truncates or
 * measures user-visible content (commit subjects, tool-input
 * summaries, tool-result excerpts).
 *
 * `String.prototype.length` counts UTF-16 code units, which is wrong
 * in two ways for terminal display:
 *
 * 1. A grapheme cluster like `✅` (U+2705) is 1 code unit but 2
 *    visual columns. Capping at `length === 72` gives a different
 *    result than capping at "72 columns of terminal output."
 * 2. `slice(0, n)` can split surrogate pairs and ZWJ sequences
 *    mid-cluster, producing a broken char that some terminals render
 *    as a replacement glyph.
 *
 * This module wraps `string-width` (for measurement) and
 * `Intl.Segmenter` (for grapheme-aware iteration) to fix both.
 */
import stringWidth from "string-width";

/** Visual column width of a string in a typical terminal. */
export function visualWidth(s: string): number {
  return stringWidth(s);
}

/** Truncate `s` so its visual width is at most `max` columns. If
 *  truncation occurs, append `ellipsis` (default `"…"`). The ellipsis
 *  itself is counted toward `max` so the result never exceeds it.
 *
 *  Walks grapheme clusters via `Intl.Segmenter`, so emoji, ZWJ
 *  sequences, and combining marks are never split mid-cluster.
 */
export function truncateToWidth(
  s: string,
  max: number,
  ellipsis = "…",
): string {
  if (max <= 0) return "";
  if (visualWidth(s) <= max) return s;

  const ellipsisWidth = visualWidth(ellipsis);
  // If `max` is too small to even fit the ellipsis, return whatever
  // graphemes fit and skip the ellipsis to avoid going over budget.
  const budget = ellipsisWidth >= max ? max : max - ellipsisWidth;

  const segmenter = new Intl.Segmenter();
  let acc = "";
  let used = 0;
  for (const { segment } of segmenter.segment(s)) {
    const w = visualWidth(segment);
    if (used + w > budget) break;
    acc += segment;
    used += w;
  }
  return ellipsisWidth >= max ? acc : acc + ellipsis;
}
