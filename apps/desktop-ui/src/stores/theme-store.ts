// 持久化主题配置，并在所有桌面窗口间同步应用。
import { useEffect } from 'react';
import { create } from 'zustand';
import {
  settingsApi,
  type ContentFontPreset,
  type ThemeConfig,
} from '../api/settings.js';
import { setThemeHue, setThemeRadius } from '@ema-agent/ui/utils';
import { tauriBridge } from '../lib/tauri-bridge.js';

const THEME_EVENT = 'theme:changed';
const THEME_ATTR  = 'data-theme';

export type ThemeMode = 'dark' | 'light';

interface ResolvedThemeConfig {
  hue: number;
  radius: number;
  mode: ThemeMode;
  contentFontPreset: ContentFontPreset;
  contentFontFamily: string;
}

const DEFAULTS: ResolvedThemeConfig = {
  hue: 200,
  radius: 1,
  mode: 'light',
  contentFontPreset: 'system',
  contentFontFamily: '',
};

const CONTENT_FONT_STACKS: Record<Exclude<ContentFontPreset, 'custom'>, string> = {
  system: 'var(--ema-font-content-system)',
  rounded: "'Nunito', 'Avenir Next', 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif",
  reading: "'LXGW WenKai', 'Kaiti SC', KaiTi, 'Yu Kyokasho', 'Microsoft YaHei', sans-serif",
};

export function normalizeLocalFontName(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80);
}

export function resolveContentFontStack(
  preset: ContentFontPreset,
  customFamily: string,
): string {
  if (preset !== 'custom') return CONTENT_FONT_STACKS[preset];
  const normalized = normalizeLocalFontName(customFamily);
  return normalized
    ? `'${normalized}', var(--ema-font-content-system)`
    : CONTENT_FONT_STACKS.system;
}

function applyContentFont(preset: ContentFontPreset, customFamily: string): void {
  document.documentElement.style.setProperty(
    '--ema-font-content',
    resolveContentFontStack(preset, customFamily),
  );
}

function resolveThemeConfig(config: ThemeConfig): ResolvedThemeConfig {
  return {
    hue: config.hue,
    radius: config.radius,
    mode: config.mode === 'dark' ? 'dark' : 'light',
    contentFontPreset: config.contentFontPreset ?? 'system',
    contentFontFamily: normalizeLocalFontName(config.contentFontFamily ?? ''),
  };
}

function applyMode(mode: ThemeMode): void {
  // 切换双向动画:切前给 <html> 加 .ema-theme-transition 触发全局 color 过渡,
  // 过渡完(400ms)移除。只过渡颜色不过渡 transform/layout(见 transitions.css)。
  const html = document.documentElement;
  html.classList.add('ema-theme-transition');

  if (mode === 'dark') {
    document.documentElement.removeAttribute(THEME_ATTR);
  } else {
    document.documentElement.setAttribute(THEME_ATTR, mode);
  }

  // Sync native title bar (Tauri window)
  try {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().setTheme(mode).catch(() => {});
    }).catch(() => {});
  } catch { /* not in Tauri */ }

  // 过渡完移除 class(过渡时长 base 200ms + buffer 200ms = 400ms)
  window.setTimeout(() => html.classList.remove('ema-theme-transition'), 400);
}

export interface ThemeStoreState {
  hue:    number;
  radius: number;
  mode:   ThemeMode;
  contentFontPreset: ContentFontPreset;
  contentFontFamily: string;
  ready:  boolean;

  init(): Promise<void>;
  setHue(hue: number): Promise<void>;
  setRadius(radius: number): Promise<void>;
  setMode(mode: ThemeMode): Promise<void>;
  setContentFont(preset: ContentFontPreset, customFamily?: string): Promise<void>;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  ...DEFAULTS,
  ready: false,

  async init() {
    try {
      const config = await settingsApi.getTheme();
      const resolved = resolveThemeConfig(config);
      setThemeHue(resolved.hue);
      setThemeRadius(resolved.radius);
      // 暗色是默认(:root 无 data-theme),亮色设 data-theme="light"。
      // 之前三元 bug(=== 'light' ? 'light' : 'light')永远 light,暗色不可切。
      applyMode(resolved.mode);
      applyContentFont(resolved.contentFontPreset, resolved.contentFontFamily);
      set({ ...resolved, ready: true });
    } catch {
      setThemeHue(DEFAULTS.hue);
      setThemeRadius(DEFAULTS.radius);
      applyMode('light');
      applyContentFont(DEFAULTS.contentFontPreset, DEFAULTS.contentFontFamily);
      set({ ...DEFAULTS, ready: true });
    }
  },

  async setHue(hue) {
    setThemeHue(hue);
    set({ hue });
    const { radius, mode, contentFontPreset, contentFontFamily } = get();
    const next = { hue, radius, mode, contentFontPreset, contentFontFamily };
    void emitTheme(next);
    try { await settingsApi.putTheme(next); } catch (err) { console.warn('[theme] putTheme(hue) failed:', err); }
  },

  async setRadius(radius) {
    setThemeRadius(radius);
    set({ radius });
    const { hue, mode, contentFontPreset, contentFontFamily } = get();
    const next = { hue, radius, mode, contentFontPreset, contentFontFamily };
    void emitTheme(next);
    try { await settingsApi.putTheme(next); } catch (err) { console.warn('[theme] putTheme(radius) failed:', err); }
  },

  async setMode(mode) {
    applyMode(mode);
    set({ mode });
    const { hue, radius, contentFontPreset, contentFontFamily } = get();
    const next = { hue, radius, mode, contentFontPreset, contentFontFamily };
    void emitTheme(next);
    // 持久化 mode(之前 putTheme 没传 mode,切换不保存)
    try { await settingsApi.putTheme(next); } catch (err) { console.warn('[theme] putTheme(mode) failed:', err); }
  },

  async setContentFont(contentFontPreset, customFamily = get().contentFontFamily) {
    const contentFontFamily = normalizeLocalFontName(customFamily);
    applyContentFont(contentFontPreset, contentFontFamily);
    set({ contentFontPreset, contentFontFamily });
    const { hue, radius, mode } = get();
    const next = { hue, radius, mode, contentFontPreset, contentFontFamily };
    void emitTheme(next);
    try { await settingsApi.putTheme(next); } catch (err) { console.warn('[theme] putTheme(contentFont) failed:', err); }
  },
}));

function emitTheme(config: ThemeConfig): void {
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

    void tauriBridge.listen<ThemeConfig>(THEME_EVENT, (e) => {
      const resolved = resolveThemeConfig(e.payload);
      setThemeHue(resolved.hue);
      setThemeRadius(resolved.radius);
      applyMode(resolved.mode);
      applyContentFont(resolved.contentFontPreset, resolved.contentFontFamily);
      useThemeStore.setState(resolved);
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
