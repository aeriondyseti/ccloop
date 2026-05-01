/**
 * Build a one-screen recap of recent activity for `--continue`.
 * Printed to stderr before the alt-screen TUI takes over so an
 * operator returning to ccloop after an overnight run sees what
 * happened without scrolling through events.jsonl. The recap
 * remains visible in scrollback once ccloop exits and the alt
 * screen is released.
 *
 * Pure function over already-loaded step records and events; the
 * caller does I/O and passes results in.
 */

import type { StepRecord } from "../loop/stepRecord.ts";
import type { EventBase } from "../state/events.ts";
import type { ChecklistProgress } from "../spec/checklist.ts";

export interface RecapInput {
  steps: readonly StepRecord[];
  events: readonly EventBase[];
  /** Caller's "now" for relative-time display. */
  now: Date;
  /** Optional SPEC.md checklist counts. Suppressed when total=0. */
  checklist?: ChecklistProgress;
}

export function buildRecap(input: RecapInput): string {
  const { steps, events, now } = input;
  const hasChecklist = (input.checklist?.total ?? 0) > 0;
  if (steps.length === 0 && events.length === 0 && !hasChecklist) return "";

  const lines: string[] = [];
  lines.push("ccloop — overnight recap");

  if (input.checklist && input.checklist.total > 0) {
    const { done, total } = input.checklist;
    const pct = Math.round((done / total) * 100);
    lines.push(`  checklist: ${done}/${total} done (${pct}%)`);
  }

  const last = steps[steps.length - 1];
  if (last) {
    const ago = humanAgo(now.getTime() - Date.parse(last.ended_at));
    lines.push(`  last activity: ${ago} ago (step ${last.step}, ${last.outcome})`);
  }

  if (steps.length > 0) {
    let success = 0, failure = 0, noop = 0;
    let cost = 0;
    let durMs = 0;
    const byCategory = new Map<string, number>();
    for (const s of steps) {
      if (s.outcome === "success") success++;
      else if (s.outcome === "failure") failure++;
      else noop++;
      cost += s.cost_usd;
      durMs += s.duration_ms;
      if (s.failure) {
        byCategory.set(s.failure.category, (byCategory.get(s.failure.category) ?? 0) + 1);
      }
    }
    lines.push(
      `  last ${steps.length} steps: ${success} ✓ · ${failure} ✗ · ${noop} no-op · $${cost.toFixed(2)} · ${formatDuration(durMs)}`,
    );
    if (byCategory.size > 0) {
      const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      lines.push(`  failures by category: ${top.map(([c, n]) => `${c}×${n}`).join(", ")}`);
    }
    const lastSubject = [...steps].reverse().find((s) => s.commit_subject)?.commit_subject;
    if (lastSubject) lines.push(`  last commit: ${truncate(lastSubject, 80)}`);
  }

  const escalations = events.filter((e) => e.type === "escalate").length;
  const pauses = events.filter((e) => e.type === "pause_enter").length;
  // SDK-init failures don't produce step records (no usage/cost data
  // available), so the steps-summary line above misses them. Count
  // them from events instead so an overnight burst of "model
  // overloaded" 5xx is visible at a glance.
  const initFailures = events.filter(
    (e) => e.type === "step_failed" && e.category === "sdk_init",
  ).length;
  // Failed notifications are operator-visible signal: a webhook /
  // push channel that was silently rejecting alerts overnight needs
  // to surface so the operator knows their on-call lane is broken,
  // not that nothing happened.
  const failedNotifications = events.filter(
    (e) => e.type === "notification_sent" && e.ok === false,
  ).length;
  if (escalations > 0 || pauses > 0 || initFailures > 0 || failedNotifications > 0) {
    const parts: string[] = [];
    if (escalations > 0) parts.push(`${escalations} escalation${escalations === 1 ? "" : "s"}`);
    if (pauses > 0) parts.push(`${pauses} pause${pauses === 1 ? "" : "s"}`);
    if (initFailures > 0) parts.push(`${initFailures} sdk_init failure${initFailures === 1 ? "" : "s"}`);
    if (failedNotifications > 0) parts.push(
      `${failedNotifications} notify failure${failedNotifications === 1 ? "" : "s"}`,
    );
    lines.push(`  events: ${parts.join(", ")}`);
  }

  // Escalation resolutions: useful when the operator scripted or
  // hand-resolved escalations overnight and wants to remember which
  // path they took (continue vs revert vs edit_spec). Counted only
  // when there's at least one — keeps recap quiet in the typical
  // no-escalation case.
  if (escalations > 0) {
    const byAction = new Map<string, number>();
    for (const e of events) {
      if (e.type !== "escalation_resolved") continue;
      const a = String(e.action ?? "unknown");
      byAction.set(a, (byAction.get(a) ?? 0) + 1);
    }
    if (byAction.size > 0) {
      const parts = [...byAction.entries()].map(([k, v]) => `${v} ${k}`);
      lines.push(`  escalations resolved: ${parts.join(", ")}`);
    }
  }

  // Instance-count line: lets the operator distinguish "single 8h
  // run" from "8 × 1h --continue resumes" at a glance. Skipped
  // when there's only one (or zero) instance — the typical case
  // doesn't need the noise.
  const instances = events.filter((e) => e.type === "instance_start").length;
  const exits = events.filter((e) => e.type === "instance_exit").length;
  if (instances > 1) {
    lines.push(`  instances: ${instances} (this resume continues prior runs)`);
  }
  // Crash detection: the current instance has emitted instance_start
  // but not instance_exit yet. So we expect exactly one unpaired
  // start. Anything more indicates a prior process that died before
  // its `finally` could fire (SIGKILL, OOM, machine reboot). Surface
  // so the operator notices — a silent crash mid-overnight is
  // exactly the failure mode this hint is for.
  const priorCrashes = Math.max(0, instances - exits - 1);
  if (priorCrashes > 0) {
    lines.push(
      `  warning: ${priorCrashes} prior instance${priorCrashes === 1 ? "" : "s"} did not exit cleanly (no instance_exit event)`,
    );
    // If we performed a recovery commit on this resume, note the sha.
    // Pairs with the crash warning so the operator knows what was
    // salvaged from the prior process's dirty tree.
    const recovery = [...events].reverse().find((e) => e.type === "recovery_commit");
    if (recovery) {
      const sha = String(recovery.commit_sha ?? "").slice(0, 7);
      if (sha) lines.push(`  recovery commit ${sha} picked up unsaved work from prior crash`);
    }
  }

  return lines.join("\n") + "\n";
}

function humanAgo(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  if (h < 24) return mr ? `${h}h${mr}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d${hr}h` : `${d}d`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return `${h}h${String(mr).padStart(2, "0")}m`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
