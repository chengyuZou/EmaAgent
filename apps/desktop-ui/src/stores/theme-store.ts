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
      setThemeHue(DEFAULTS.hue);
      setThemeRadius(DEFAULTS.radius);
      set({ ...DEFAULTS, ready: true });
    }
  },

  async setHue(hue) {
    setThemeHue(hue);
    set({ hue });
    void tauriBridge.emit(THEME_EVENT, { hue, radius: get().radius });
    try { await settingsApi.putTheme({ hue, radius: get().radius }); } catch { /* ok */ }
  },

  async setRadius(radius) {
    setThemeRadius(radius);
    set({ radius });
    void tauriBridge.emit(THEME_EVENT, { hue: get().hue, radius });
    try { await settingsApi.putTheme({ hue: get().hue, radius }); } catch { /* ok */ }
  },
}));

export function useThemeSync(): void {
  useEffect(() => {
    void useThemeStore.getState().init();

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void tauriBridge.listen<ThemeConfig>(THEME_EVENT, (e) => {
      setThemeHue(e.payload.hue);
      setThemeRadius(e.payload.radius);
      useThemeStore.setState({ hue: e.payload.hue, radius: e.payload.radius });
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
