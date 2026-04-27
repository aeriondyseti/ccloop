/**
 * Branded string types for IDs and timestamps that are otherwise
 * indistinguishable from arbitrary text. The brands are erased at
 * runtime; the constructors are pure casts and exist only to mark
 * I/O boundary points where untyped strings cross into typed code.
 */

export type Sha = string & { readonly __brand: "Sha" };
export type RunId = string & { readonly __brand: "RunId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };

export const asSha = (s: string): Sha => s as Sha;
export const asRunId = (s: string): RunId => s as RunId;
export const asSessionId = (s: string): SessionId => s as SessionId;
export const asIsoTimestamp = (s: string): IsoTimestamp => s as IsoTimestamp;

export const nowIso = (now: () => number = Date.now): IsoTimestamp =>
  asIsoTimestamp(new Date(now()).toISOString());

export const isoFromDate = (d: Date): IsoTimestamp =>
  asIsoTimestamp(d.toISOString());

export const isoFromMs = (ms: number): IsoTimestamp =>
  asIsoTimestamp(new Date(ms).toISOString());

export const newRunId = (): RunId => asRunId(crypto.randomUUID());
