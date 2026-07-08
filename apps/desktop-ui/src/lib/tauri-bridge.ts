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

  /**
   * Open a native "Open File" (or directory) dialog (single selection).
   * Returns the absolute path of the selected file/folder, or null if cancelled.
   * Returns null when Tauri is absent (browser / Ladle dev mode).
   */
  openFileDialog(opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    /** When true, opens a directory picker instead of a file picker. */
    directory?: boolean;
  }): Promise<string | null>;

  /**
   * Open a native "Open File" dialog with multi-selection enabled.
   * Returns the absolute paths of all selected files (empty array if cancelled).
   * Returns [] when Tauri is absent (browser / Ladle dev mode).
   */
  openFileDialogMultiple(opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string[]>;

  /**
   * Query real file metadata (size / mtime / isDir) for a local path.
   * Used by attachment upload to avoid hardcoding size:0 (which bypasses the
   * 5MB image-inline limit and silently turn_fails on large images).
   * Returns null when Tauri is absent (browser / Ladle dev mode) — caller falls back to 0.
   */
  fileMetadata(path: string): Promise<{ size: number; mtime: number; isDir: boolean } | null>;

  /**
   * Subscribe to native OS-level file drag-and-drop events on the current webview.
   * Tauri 2 disables HTML5 drop events by default (so we can read file *paths*,
   * not just File contents). Position is in physical pixels — divide by
   * window.devicePixelRatio to compare with getBoundingClientRect (CSS px).
   * Returns a no-op unlisten when Tauri is absent.
   */
  onDragDrop(handler: (event: {
    type: 'enter' | 'over' | 'drop' | 'leave';
    paths?: string[];
    position?: { x: number; y: number };
  }) => void): Promise<() => void>;


  /**
   * Open a URL in the system's default browser.
   * Uses Tauri's plugin:opener when available; falls back to window.open.
   */
  openUrl(url: string): Promise<void>;

  /**
   * Open a local file or folder path in its system default handler
   * (Explorer on Windows, Finder on macOS, etc.).
   * No-ops gracefully when Tauri is absent (browser / Ladle dev mode).
   */
  openPath(path: string): Promise<void>;
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
type TauriWebview = typeof import('@tauri-apps/api/webview');

let _core:   TauriCore   | null = null;
let _event:  TauriEvent  | null = null;
let _dialog: TauriDialog | null = null;
let _window: TauriWindow | null = null;
let _webview: TauriWebview | null = null;

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

async function getWebview(): Promise<TauriWebview | null> {
  if (!detectTauri()) return null;
  if (_webview) return _webview;
  try {
    _webview = await import('@tauri-apps/api/webview');
    return _webview;
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

  async openFileDialog(opts = {}): Promise<string | null> {
    const dialog = await getDialog();
    if (!dialog) return null;
    const result = await dialog.open({ multiple: false, ...opts });
    if (Array.isArray(result)) return result[0] ?? null;
    return result as string | null;
  },

  async openFileDialogMultiple(opts = {}): Promise<string[]> {
    const dialog = await getDialog();
    if (!dialog) return [];
    const result = await dialog.open({ multiple: true, ...opts });
    if (Array.isArray(result)) return result as string[];
    // single-select falls through as a 1-element array; cancel → []
    return result ? [result as string] : [];
  },

  async fileMetadata(path: string): Promise<{ size: number; mtime: number; isDir: boolean } | null> {
    return tauriBridge.invoke<{ size: number; mtime: number; is_dir: boolean }>('file_metadata', { path })
      .then((m) => m ? { size: m.size, mtime: m.mtime, isDir: m.is_dir } : null)
      .catch(() => null);
  },

  async onDragDrop(handler: (event: {
    type: 'enter' | 'over' | 'drop' | 'leave';
    paths?: string[];
    position?: { x: number; y: number };
  }) => void): Promise<() => void> {
    const webview = await getWebview();
    if (!webview) return () => {};
    const unlisten = await webview.getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'leave') {
        handler({ type: 'leave' });
      } else if (p.type === 'over') {
        handler({ type: 'over', position: { x: p.position.x, y: p.position.y } });
      } else {
        // enter / drop 都带 paths
        handler({ type: p.type, paths: p.paths, position: { x: p.position.x, y: p.position.y } });
      }
    });
    return () => unlisten();
  },

  async openUrl(url: string): Promise<void> {
    // Tauri 2: plugin:opener|open_url (requires @tauri-apps/plugin-opener in tauri.conf.json).
    // Falls back to window.open which Tauri webview routes to the system browser.
    const core = await getCore();
    if (core) {
      try {
        await core.invoke('plugin:opener|open_url', { url });
        return;
      } catch { /* plugin not configured — fall through */ }
    }
    window.open(url, '_blank');
  },

  async openPath(path: string): Promise<void> {
    const core = await getCore();
    if (!core) { console.warn('[openPath] no Tauri core (browser mode?)'); return; }
    console.log('[openPath] invoking open_path:', path);
    try {
      await core.invoke('plugin:opener|open_path', { path });
      console.log('[openPath] invoke OK');
    } catch (err) {
      console.error('[openPath] invoke failed:', err);
      const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : JSON.stringify(err));
      throw new Error('openPath: ' + msg);
    }
  },
};
