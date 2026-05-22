// ── Tauri window-control wrapper ────────────────────────────────────────────
//
// Thin wrapper around the Tauri commands defined in src-tauri/src/lib.rs.
// Lazy-imports @tauri-apps/api/core so the bundle still loads in plain Vite
// (browser-only dev) without Tauri being present.

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    return await mod.invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

export const invokeWindow = {
  async setAlwaysOnTop(value: boolean): Promise<void> {
    await tauriInvoke('set_always_on_top', { value });
  },
  async setPassthrough(value: boolean): Promise<void> {
    await tauriInvoke('set_passthrough', { value });
  },
  async quit(): Promise<void> {
    await tauriInvoke('quit_app');
  },
};
