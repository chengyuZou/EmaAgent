import { useEffect } from 'react';
import { create } from 'zustand';
import { settingsApi, type ThemeConfig } from '../api/settings.js';
import { setThemeHue, setThemeRadius } from '@ema-agent/ui/utils';
import { tauriBridge } from '../lib/tauri-bridge.js';

const THEME_EVENT = 'theme:changed';

const DEFAULTS: ThemeConfig = { hue: 350, radius: 1 };

export interface ThemeStoreState {
  hue:    number;
  radius: number;
  ready:  boolean;

  /** Load from API and apply CSS vars. Call once on app init. */
  init(): Promise<void>;
  setHue(hue: number): Promise<void>;
  setRadius(radius: number): Promise<void>;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  ...DEFAULTS,
  ready: false,

  async init() {
    try {
      const config = await settingsApi.getTheme();
      setThemeHue(config.hue);
      setThemeRadius(config.radius);
      set({ hue: config.hue, radius: config.radius, ready: true });
    } catch {
      // Sidecar not yet ready — apply defaults and mark ready anyway
      setThemeHue(DEFAULTS.hue);
      setThemeRadius(DEFAULTS.radius);
      set({ ...DEFAULTS, ready: true });
    }
  },

  async setHue(hue) {
    setThemeHue(hue);
    set({ hue });
    const radius = get().radius;
    void tauriBridge.emit(THEME_EVENT, { hue, radius });
    try {
      await settingsApi.putTheme({ hue, radius });
    } catch { /* non-blocking */ }
  },

  async setRadius(radius) {
    setThemeRadius(radius);
    set({ radius });
    const hue = get().hue;
    void tauriBridge.emit(THEME_EVENT, { hue, radius });
    try {
      await settingsApi.putTheme({ hue, radius });
    } catch { /* non-blocking */ }
  },
}));

/**
 * Call this once in the root of each Tauri window.
 * - Fetches and applies the saved theme on mount.
 * - Listens for theme:changed events from other windows (e.g. settings window).
 */
export function useThemeSync(): void {
  useEffect(() => {
    void useThemeStore.getState().init();

    let unlisten: (() => void) | undefined;
    void tauriBridge.listen<ThemeConfig>(THEME_EVENT, (e) => {
      setThemeHue(e.payload.hue);
      setThemeRadius(e.payload.radius);
      useThemeStore.setState({ hue: e.payload.hue, radius: e.payload.radius });
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);
}
