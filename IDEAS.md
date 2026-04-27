# Ideas

Ideas sparked while working on ccloop, not part of ccloop's own scope.
These are candidate projects of their own — and good "first runs" for
ccloop once it's working.

## Token-usage reconciliation hook

A Claude Code hook (likely `PostToolUse` or `Stop`) that records local
per-message token counts as Claude reports them, then periodically
fetches the live OAuth usage endpoint
(`GET /api/oauth/usage` with the OAuth Bearer token) and compares the
two.

Goals:
- Detect drift between local token accounting and Anthropic's
  authoritative window utilization.
- Surface anomalies (e.g. local says 40% used but API says 80%, or
  vice versa) as a signal that something — caching, accounting,
  endpoint behavior — has shifted.
- Build a record over time that informs ccloop's own
  `usage_throttle_threshold` and pause-pre-flight logic.

Why it's a good ccloop first-run candidate:
- Small, well-scoped surface.
- Verifiable (the hook either records the right numbers or it doesn't).
- Useful regardless of ccloop's success — pays off as a standalone tool.
- Exercises the same APIs ccloop depends on, so the run doubles as
  empirical validation of those endpoints.
