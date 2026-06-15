// ── Best-effort wrapper ───────────────────────────────────────────────────────
//
// The memory pipeline is deliberately best-effort: a failed extraction or
// pending-fragment write must NEVER break the user's turn. But best-effort
// without logging is how memories silently stop persisting for weeks with
// zero clues ("禁止静默失败" — CLAUDE.md). Every swallowed error goes through
// here so failures are visible and rate-limited.

let warnCount = 0;
const WARN_CAP = 200; // beyond this, assume a log storm and go quiet

function warn(label: string, err: unknown): void {
  if (warnCount >= WARN_CAP) return;
  warnCount += 1;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[memory] ${label} failed (best-effort, continuing): ${detail}`);
  if (warnCount === WARN_CAP) {
    console.warn('[memory] warning cap reached — further best-effort failures muted');
  }
}

/** Run `fn`; on throw, log once under `label` and return `fallback`. */
export function bestEffort<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    warn(label, err);
    return fallback;
  }
}

/** Async variant of bestEffort. */
export async function bestEffortAsync<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    warn(label, err);
    return fallback;
  }
}
