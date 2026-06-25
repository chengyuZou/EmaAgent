import { useEffect } from 'react';
import { create } from 'zustand';
import { settingsApi, type ThemeConfig } from '../api/settings.js';
import { setThemeHue, setThemeRadius } from '@ema-agent/ui/utils';
import { tauriBridge } from '../lib/tauri-bridge.js';

const THEME_EVENT = 'theme:changed';
const THEME_ATTR  = 'data-theme';

export type ThemeMode = 'dark' | 'light';

const DEFAULTS: ThemeConfig = { hue: 200, radius: 1 };

function applyMode(mode: ThemeMode): void {
  document.documentElement.setAttribute(THEME_ATTR, mode);
  if (mode === 'dark') document.documentElement.removeAttribute(THEME_ATTR);

  // Sync native title bar (Tauri window)
  try {
    // Dynamic import so it doesn't break in non-Tauri contexts
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().setTheme(mode).catch(() => {});
    }).catch(() => {});
  } catch { /* not in Tauri */ }
}

export interface ThemeStoreState {
  hue:    number;
  radius: number;
  mode:   ThemeMode;
  ready:  boolean;

  init(): Promise<void>;
  setHue(hue: number): Promise<void>;
  setRadius(radius: number): Promise<void>;
  setMode(mode: ThemeMode): Promise<void>;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  ...DEFAULTS,
  mode: 'light' as ThemeMode,
  ready: false,

  async init() {
    try {
      const config = await settingsApi.getTheme();
      setThemeHue(config.hue);
      setThemeRadius(config.radius);
      const mode: ThemeMode = (config as any).mode === 'light' ? 'light' : 'light';
      applyMode(mode);
      set({ hue: config.hue, radius: config.radius, mode, ready: true });
    } catch {
      setThemeHue(DEFAULTS.hue);
      setThemeRadius(DEFAULTS.radius);
      applyMode('light');
      set({ ...DEFAULTS, mode: 'light' as ThemeMode, ready: true });
    }
  },

  async setHue(hue) {
    setThemeHue(hue);
    set({ hue });
    const { radius, mode } = get();
    void emitTheme({ hue, radius, mode });
    try { await settingsApi.putTheme({ hue, radius }); } catch { /* ok */ }
  },

  async setRadius(radius) {
    setThemeRadius(radius);
    set({ radius });
    const { hue, mode } = get();
    void emitTheme({ hue, radius, mode });
    try { await settingsApi.putTheme({ hue, radius }); } catch { /* ok */ }
  },

  async setMode(mode) {
    applyMode(mode);
    set({ mode });
    const { hue, radius } = get();
    void emitTheme({ hue, radius, mode });
    try { await settingsApi.putTheme({ hue, radius }); } catch { /* ok */ }
  },
}));

function emitTheme(config: ThemeConfig & { mode?: ThemeMode }): void {
  void tauriBridge.emit(THEME_EVENT, config);
}

/**
 * Call this once in the root of each Tauri window.
 * - Fetches and applies the saved theme on mount.
 * - Listens for theme:changed events from other windows (e.g. settings window).
 */
export function useThemeSync(): void {
  useEffect(() => {
    void useThemeStore.getState().init();

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void tauriBridge.listen<ThemeConfig & { mode?: ThemeMode }>(THEME_EVENT, (e) => {
      setThemeHue(e.payload.hue);
      setThemeRadius(e.payload.radius);
      const mode: ThemeMode = e.payload.mode === 'light' ? 'light' : 'light';
      applyMode(mode);
      useThemeStore.setState({ hue: e.payload.hue, radius: e.payload.radius, mode });
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
