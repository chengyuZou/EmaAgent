/**
 * Tauri bridge — the single choke-point for all Tauri IPC.
 *
 * Every `@tauri-apps/api/*` import lives HERE. No other file in
 * `@ema-agent/desktop-ui` is allowed to import from `@tauri-apps/api`
 * directly. This gives us a plain-browser fallback so Ladle stories
 * and unit tests can render without Tauri.
 */

// ── Public interface ─────────────────────────────────────────────────────────

export interface TauriBridge {
  /** Call a Rust command. Returns `null` when Tauri is absent. */
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null>;

  /** Emit a cross-window event. No-op when Tauri is absent. */
  emit(eventName: string, payload?: unknown): Promise<void>;

  /**
   * Listen for cross-window events. Returns an unsubscribe function.
   * Returns a no-op unsubscribe when Tauri is absent.
   */
  listen<T>(eventName: string, handler: (event: { payload: T }) => void): Promise<() => void>;

  /** Whether the Tauri runtime is available. */
  isTauri(): boolean;
}

// ── Detection ────────────────────────────────────────────────────────────────

let _detected: boolean | null = null;

function detectTauri(): boolean {
  if (_detected !== null) return _detected;
  try {
    _detected = '__TAURI_INTERNALS__' in window;
  } catch {
    _detected = false;
  }
  if (!_detected) {
    console.debug('[tauri-bridge] plain browser mode');
  }
  return _detected;
}

// ── Lazy imports ─────────────────────────────────────────────────────────────

type TauriCore = typeof import('@tauri-apps/api/core');
type TauriEvent = typeof import('@tauri-apps/api/event');

let _core: TauriCore | null = null;
let _event: TauriEvent | null = null;

async function getCore(): Promise<TauriCore | null> {
  if (!detectTauri()) return null;
  if (_core) return _core;
  try {
    _core = await import('@tauri-apps/api/core');
    return _core;
  } catch {
    _detected = false;
    return null;
  }
}

async function getEvent(): Promise<TauriEvent | null> {
  if (!detectTauri()) return null;
  if (_event) return _event;
  try {
    _event = await import('@tauri-apps/api/event');
    return _event;
  } catch {
    _detected = false;
    return null;
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

export const tauriBridge: TauriBridge = {
  isTauri: detectTauri,

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const core = await getCore();
    if (!core) return null;
    return core.invoke<T>(cmd, args);
  },

  async emit(eventName: string, payload?: unknown): Promise<void> {
    const event = await getEvent();
    if (!event) return;
    await event.emit(eventName, payload);
  },

  async listen<T>(
    eventName: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> {
    const event = await getEvent();
    if (!event) return () => {};
    const unlisten = await event.listen<T>(eventName, handler);
    return () => unlisten();
  },
};
