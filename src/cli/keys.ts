/**
 * Single-keypress reader for the §9.6 / §10.5 escalation and
 * guardrail-trip screens. Operates on raw stdin in TTY mode; falls
 * back to a no-op (resolves "q") on non-TTY so headless runs exit.
 */
export async function readSingleKey(
  allowed: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!process.stdin.isTTY) return "q";
  return await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk: string) => {
      const ch = chunk[0]?.toLowerCase() ?? "";
      if (ch === "") {
        // ctrl-c
        cleanup();
        resolve("q");
        return;
      }
      if (allowed.includes(ch)) {
        cleanup();
        resolve(ch);
      }
      // ignore other keys
    };
    const onAbort = () => {
      cleanup();
      resolve("q");
    };
    function cleanup() {
      stdin.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      try { stdin.setRawMode?.(false); } catch { /* ignore */ }
      stdin.pause();
    }
    stdin.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
