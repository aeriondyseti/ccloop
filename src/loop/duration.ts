import parse from "parse-duration";

/** Parse a duration string per §10.3 (`"8h"`, `"30m"`, `"1d 2h"`). Returns ms or null. */
export function parseWallClock(input: string): number | null {
  if (!input) return null;
  const ms = parse(input);
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}
