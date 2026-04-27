/**
 * Read recent step records from `./.ccloop/steps/` for the TUI.
 * Malformed JSON files are skipped per §13b.5.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { StepRecord } from "../loop/stepRecord.ts";
import type { Sha } from "../branded.ts";

async function listStepNames(stepsDir: string): Promise<string[]> {
  try {
    const names = await readdir(stepsDir);
    return names.filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readStepRecord(stepsDir: string, name: string): Promise<StepRecord | null> {
  try {
    const text = await readFile(join(stepsDir, name), "utf8");
    const rec = JSON.parse(text) as StepRecord;
    if (rec && typeof rec.step === "number") return rec;
  } catch {
    // malformed → skip
  }
  return null;
}

export async function findLastGreenSha(stepsDir: string): Promise<Sha | null> {
  const names = (await listStepNames(stepsDir)).reverse();
  for (const name of names) {
    const rec = await readStepRecord(stepsDir, name);
    if (rec && rec.outcome === "success" && rec.commit_sha) return rec.commit_sha;
  }
  return null;
}

export async function loadRecentSteps(
  stepsDir: string,
  limit: number = 5,
): Promise<StepRecord[]> {
  const names = await listStepNames(stepsDir);
  const tail = names.slice(-limit);
  const records = await Promise.all(tail.map((n) => readStepRecord(stepsDir, n)));
  return records.filter((r): r is StepRecord => r !== null);
}
