/**
 * Session metadata persistence for the design loop.
 *
 * Enables resume functionality by saving/loading session state to
 * ./.ccloop/design/session.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isENOENT } from "../errors.ts";
import { getDesignSessionMetadataPath } from "./paths.ts";
import type { DesignSessionMetadata, DesignPhase } from "./types.ts";
import { nowIso } from "../branded.ts";

/**
 * Save session metadata to disk.
 *
 * @param cwd - Current working directory
 * @param metadata - Session metadata to save
 */
export async function saveSessionMetadata(
  cwd: string,
  metadata: DesignSessionMetadata
): Promise<void> {
  const path = getDesignSessionMetadataPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(metadata, null, 2), "utf8");
}

/**
 * Load session metadata from disk.
 *
 * @param cwd - Current working directory
 * @returns Session metadata
 * @throws If session.json doesn't exist or is invalid
 */
export async function loadSessionMetadata(
  cwd: string
): Promise<DesignSessionMetadata> {
  const path = getDesignSessionMetadataPath(cwd);
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content);

  // Validate required fields
  if (!parsed.started_at || typeof parsed.started_at !== "string") {
    throw new Error("Invalid session metadata: missing or invalid started_at");
  }
  if (!parsed.current_phase || typeof parsed.current_phase !== "string") {
    throw new Error("Invalid session metadata: missing or invalid current_phase");
  }
  if (typeof parsed.turn_count !== "number") {
    throw new Error("Invalid session metadata: missing or invalid turn_count");
  }
  if (typeof parsed.total_cost_usd !== "number") {
    throw new Error("Invalid session metadata: missing or invalid total_cost_usd");
  }

  return parsed as DesignSessionMetadata;
}

/**
 * Load session metadata if it exists, otherwise return null.
 *
 * @param cwd - Current working directory
 * @returns Session metadata or null if doesn't exist
 */
export async function loadSessionMetadataIfExists(
  cwd: string
): Promise<DesignSessionMetadata | null> {
  try {
    return await loadSessionMetadata(cwd);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

/**
 * Create initial session metadata for a new design session.
 *
 * @param initialPhase - Starting phase (defaults to "vision")
 * @returns New session metadata
 */
export function createSessionMetadata(
  initialPhase: DesignPhase = "vision"
): DesignSessionMetadata {
  return {
    started_at: nowIso(),
    current_phase: initialPhase,
    turn_count: 0,
    total_cost_usd: 0,
  };
}

/**
 * Update session metadata with new values.
 *
 * Convenience function for incrementally updating session state.
 *
 * @param metadata - Current metadata
 * @param updates - Partial updates to apply
 * @returns Updated metadata
 */
export function updateSessionMetadata(
  metadata: DesignSessionMetadata,
  updates: Partial<DesignSessionMetadata>
): DesignSessionMetadata {
  return {
    ...metadata,
    ...updates,
  };
}

/**
 * Check if a session is resumable.
 *
 * A session is resumable if:
 * - session.json exists and is valid
 * - spec.draft.md exists
 * - Session hasn't been accepted yet
 *
 * @param cwd - Current working directory
 * @returns true if session can be resumed
 */
export async function isSessionResumable(cwd: string): Promise<boolean> {
  try {
    const metadata = await loadSessionMetadata(cwd);
    if (metadata.accepted) {
      return false; // Already accepted, not resumable
    }

    // Check if draft exists
    const { loadDraftIfExists } = await import("./draft.ts");
    const draft = await loadDraftIfExists(cwd);
    return draft !== null;
  } catch {
    return false;
  }
}
