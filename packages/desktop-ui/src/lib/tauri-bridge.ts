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

  /** Retrieve the shared secret generated at sidecar startup. Returns null in browser mode. */
  getSidecarSecret(): Promise<string | null>;

  /** Show / focus a pre-declared sub-window by label (chat / settings). */
  openWindow(label: string): Promise<void>;

  /** Quit the entire application. */
  quit(): Promise<void>;

  /** Toggle always-on-top for the current window. */
  setAlwaysOnTop(value: boolean): Promise<void>;

  /** Toggle mouse passthrough for the current window. */
  setPassthrough(value: boolean): Promise<void>;

  /** Begin native window drag. Must be called from a mousedown handler. */
  startDragging(): Promise<void>;

  /**
   * Global cursor position + current window bounds, all in physical pixels.
   * Polled by the dynamic-passthrough loop — works even while the window
   * ignores cursor events (cursorPosition is OS-global, not a window event).
   * Returns null when Tauri is absent.
   */
  cursorAndBounds(): Promise<{
    cursor: { x: number; y: number };
    win:    { x: number; y: number; width: number; height: number };
    scale:  number;
  } | null>;

  /**
   * Open a native "Save As" dialog starting at defaultPath.
   * Returns the chosen absolute path, or null if the user cancelled.
   * Returns null when Tauri is absent (browser / Ladle dev mode).
   */
  saveFileDialog(opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | null>;
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

type TauriCore   = typeof import('@tauri-apps/api/core');
type TauriEvent  = typeof import('@tauri-apps/api/event');
type TauriDialog = typeof import('@tauri-apps/plugin-dialog');
type TauriWindow = typeof import('@tauri-apps/api/window');

let _core:   TauriCore   | null = null;
let _event:  TauriEvent  | null = null;
let _dialog: TauriDialog | null = null;
let _window: TauriWindow | null = null;

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

async function getDialog(): Promise<TauriDialog | null> {
  if (!detectTauri()) return null;
  if (_dialog) return _dialog;
  try {
    _dialog = await import('@tauri-apps/plugin-dialog');
    return _dialog;
  } catch {
    return null;
  }
}

async function getWindow(): Promise<TauriWindow | null> {
  if (!detectTauri()) return null;
  if (_window) return _window;
  try {
    _window = await import('@tauri-apps/api/window');
    return _window;
  } catch {
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

  async openWindow(label: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('open_window', { label });
  },

  async quit(): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('quit_app');
  },

  async setAlwaysOnTop(value: boolean): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('set_always_on_top', { value });
  },

  async setPassthrough(value: boolean): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('set_passthrough', { value });
  },

  async startDragging(): Promise<void> {
    const winMod = await getWindow();
    if (!winMod) return;
    await winMod.getCurrentWindow().startDragging();
  },

  async cursorAndBounds() {
    const winMod = await getWindow();
    if (!winMod) return null;
    const w = winMod.getCurrentWindow();
    const [cursor, pos, size, scale] = await Promise.all([
      winMod.cursorPosition(),
      w.outerPosition(),
      w.outerSize(),
      w.scaleFactor(),
    ]);
    return {
      cursor: { x: cursor.x, y: cursor.y },
      win:    { x: pos.x, y: pos.y, width: size.width, height: size.height },
      scale,
    };
  },

  async getSidecarSecret(): Promise<string | null> {
    return tauriBridge.invoke<string>('get_sidecar_secret');
  },

  async saveFileDialog(opts = {}): Promise<string | null> {
    const dialog = await getDialog();
    if (!dialog) return null;
    return dialog.save(opts);
  },
};
