// 持久化主题配置，并在所有桌面窗口间同步应用。
// 主题是 frontend.theme 设置值：字段范围由 server 侧 zod schema 校验，类型直接引用拥有方。
import { useEffect } from 'react';
import { create } from 'zustand';
import { settingsApi } from '../api/settings.js';
import { setThemeHue, setThemeRadius } from '@ema-agent/ui/utils';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { ThemeSettings } from '@ema-agent/server/composition/settings/themeSetting.js';

const THEME_ATTR  = 'data-theme';
const THEME_SETTING_KEY = 'frontend.theme';

/** 首帧渲染与 server 不可达时的兜底；server 的 values 解码本身已带默认值。 */
const DEFAULTS: ThemeSettings = {
  hue: 200,
  radius: 1,
  mode: 'light',
  contentFontPreset: 'system',
  contentFontFamily: '',
};

const CONTENT_FONT_STACKS: Record<Exclude<ThemeSettings['contentFontPreset'], 'custom'>, string> = {
  system: 'var(--ema-font-content-system)',
  rounded: "'Nunito', 'Avenir Next', 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif",
  reading: "'LXGW WenKai', 'Kaiti SC', KaiTi, 'Yu Kyokasho', 'Microsoft YaHei', sans-serif",
};

export function normalizeLocalFontName(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80);
}

export function resolveContentFontStack(
  preset: ThemeSettings['contentFontPreset'],
  customFamily: string,
): string {
  if (preset !== 'custom') return CONTENT_FONT_STACKS[preset];
  const normalized = normalizeLocalFontName(customFamily);
  return normalized
    ? `'${normalized}', var(--ema-font-content-system)`
    : CONTENT_FONT_STACKS.system;
}

function applyContentFont(preset: ThemeSettings['contentFontPreset'], customFamily: string): void {
  document.documentElement.style.setProperty(
    '--ema-font-content',
    resolveContentFontStack(preset, customFamily),
  );
}

/** 设置 KV 通道不带类型，这里做入口收窄；坏字段逐项回落默认而不是整份丢弃。 */
function readThemeValue(value: unknown): ThemeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULTS;
  const raw = value as Record<string, unknown>;
  const mode: ThemeSettings['mode'] = raw.mode === 'dark' ? 'dark' : 'light';
  const preset: ThemeSettings['contentFontPreset'] =
    raw.contentFontPreset === 'rounded'
    || raw.contentFontPreset === 'reading'
    || raw.contentFontPreset === 'custom'
      ? raw.contentFontPreset
      : 'system';
  return {
    hue: typeof raw.hue === 'number' ? raw.hue : DEFAULTS.hue,
    radius: typeof raw.radius === 'number' ? raw.radius : DEFAULTS.radius,
    mode,
    contentFontPreset: preset,
    contentFontFamily: normalizeLocalFontName(
      typeof raw.contentFontFamily === 'string' ? raw.contentFontFamily : '',
    ),
  };
}

function applyResolvedTheme(config: ThemeSettings): void {
  setThemeHue(config.hue);
  setThemeRadius(config.radius);
  applyMode(config.mode);
  applyContentFont(config.contentFontPreset, config.contentFontFamily);
}

function applyMode(mode: ThemeSettings['mode']): void {
  // 切换双向动画:切前给 <html> 加 .ema-theme-transition 触发全局 color 过渡,
  // 过渡完(400ms)移除。只过渡颜色不过渡 transform/layout(见 transitions.css)。
  const html = document.documentElement;
  html.classList.add('ema-theme-transition');

  if (mode === 'dark') {
    document.documentElement.removeAttribute(THEME_ATTR);
  } else {
    document.documentElement.setAttribute(THEME_ATTR, mode);
  }

  // 同步原生标题栏配色（Tauri 窗口）。
  void tauriBridge.setWindowTheme(mode);

  // 过渡完移除 class(过渡时长 base 200ms + buffer 200ms = 400ms)
  window.setTimeout(() => html.classList.remove('ema-theme-transition'), 400);
}

export interface ThemeStoreState {
  hue:    number;
  radius: number;
  mode:   ThemeSettings['mode'];
  contentFontPreset: ThemeSettings['contentFontPreset'];
  contentFontFamily: string;
  ready:  boolean;

  init(): Promise<void>;
  setHue(hue: number): Promise<void>;
  setRadius(radius: number): Promise<void>;
  setMode(mode: ThemeSettings['mode']): Promise<void>;
  setContentFont(preset: ThemeSettings['contentFontPreset'], customFamily?: string): Promise<void>;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  ...DEFAULTS,
  ready: false,

  async init() {
    try {
      const { value } = await settingsApi.getValue(THEME_SETTING_KEY);
      const resolved = readThemeValue(value);
      applyResolvedTheme(resolved);
      set({ ...resolved, ready: true });
    } catch {
      applyResolvedTheme(DEFAULTS);
      set({ ...DEFAULTS, ready: true });
    }
  },

  async setHue(hue) {
    const previous = currentThemeValue(get());
    const next = { ...previous, hue };
    await persistThemeChange(next, previous, value => set(value));
  },

  async setRadius(radius) {
    const previous = currentThemeValue(get());
    const next = { ...previous, radius };
    await persistThemeChange(next, previous, value => set(value));
  },

  async setMode(mode) {
    const previous = currentThemeValue(get());
    const next = { ...previous, mode };
    await persistThemeChange(next, previous, value => set(value));
  },

  async setContentFont(contentFontPreset, customFamily = get().contentFontFamily) {
    const previous = currentThemeValue(get());
    const contentFontFamily = normalizeLocalFontName(customFamily);
    const next = { ...previous, contentFontPreset, contentFontFamily };
    await persistThemeChange(next, previous, value => set(value));
  },
}));

function emitTheme(config: ThemeSettings): void {
  void tauriBridge.publishThemeChanged(config);
}

function currentThemeValue(state: ThemeStoreState): ThemeSettings {
  return {
    hue: state.hue,
    radius: state.radius,
    mode: state.mode,
    contentFontPreset: state.contentFontPreset,
    contentFontFamily: state.contentFontFamily,
  };
}

async function persistThemeChange(
  next: ThemeSettings,
  previous: ThemeSettings,
  updateState: (value: ThemeSettings) => void,
): Promise<void> {
  // 当前窗口先预览；只有 SQLite 提交成功后才通知其他窗口。
  applyResolvedTheme(next);
  updateState(next);
  try {
    const { value } = await settingsApi.putValue(THEME_SETTING_KEY, next);
    const saved = readThemeValue(value);
    applyResolvedTheme(saved);
    updateState(saved);
    emitTheme(saved);
  } catch (error) {
    applyResolvedTheme(previous);
    updateState(previous);
    throw error;
  }
}

/** 每个 Tauri 窗口根部调用一次：挂载时取回并应用主题，监听其他窗口的 theme:changed。 */
export function useThemeSync(): void {
  useEffect(() => {
    void useThemeStore.getState().init();

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void tauriBridge.listenThemeChanged((theme) => {
      const resolved = readThemeValue(theme);
      applyResolvedTheme(resolved);
      useThemeStore.setState(resolved);
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
