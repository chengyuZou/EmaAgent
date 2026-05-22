// ── Sidecar status probe ────────────────────────────────────────────────────
//
// Asks Tauri for the sidecar's listening port, then hits /api/health on it.
// Tauri's `invoke` is dynamically imported so this file can run in plain
// Vite (without Tauri) too — useful for unit / Storybook tests later.

export type SidecarStatus =
  | { kind: 'pending' }
  | { kind: 'ok';    port: number }
  | { kind: 'error'; reason: string };

export async function getSidecarStatus(): Promise<SidecarStatus> {
  const port = await fetchSidecarPort();
  if (port === null) return { kind: 'error', reason: 'tauri get_sidecar_port unavailable' };

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      // localhost so no CORS — but be explicit about cache to avoid stale
      cache:  'no-store',
    });
    if (!res.ok) return { kind: 'error', reason: `health http ${res.status}` };
    return { kind: 'ok', port };
  } catch (err) {
    return { kind: 'error', reason: (err as Error).message };
  }
}

/**
 * Returns the sidecar's actual listening port (resolved by Rust by parsing
 * the sidecar's stdout). Returns null if Tauri APIs aren't present (i.e.
 * we're running plain `vite` outside Tauri — useful for component dev).
 */
async function fetchSidecarPort(): Promise<number | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    const port = await mod.invoke<number>('get_sidecar_port');
    return port;
  } catch {
    return null;
  }
}
