// 持久化主题配置, 并在所有桌面窗口间同步应用.
// 主题是 frontend.theme 设置值: 字段范围由 server 侧 zod schema 校验, 类型直接引用拥有方.
import { useEffect } from 'react';
import { create } from 'zustand';
import { settingsApi } from '../api/settings.js';
import { setThemeHue, setThemeRadius } from '@ema-agent/ui/utils';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { ThemeSettings } from '@ema-agent/server/settings/themeSetting.js';
import {
  DEFAULT_THEME_SETTINGS,
  THEME_SETTING_KEY,
  READING_FONT_FALLBACK,
  CODE_FONT_FALLBACK,
} from '@ema-agent/server/settings/themeCatalog.js';
import { useCharacterStore } from './character.js';
import { sampleActiveCharacterHue } from '../lib/dynamicHue.js';

const THEME_ATTR  = 'data-theme';

export function normalizeLocalFontName(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80);
}

/** 族名在前, 回退链在后; 空族名直接用回退链. */
function resolveFontStack(family: string, fallback: string): string {
  const normalized = normalizeLocalFontName(family);
  return normalized ? `'${normalized}', ${fallback}` : fallback;
}

/** canvas 测量法探测字体是否真实安装, 用于设置页提示"未安装会回落" */
export function isFontInstalled(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const probe = 'mmmmmmmmmmlli';
  ctx.font = '72px monospace';
  const baseline = ctx.measureText(probe).width;
  ctx.font = `72px '${family}', monospace`;
  return ctx.measureText(probe).width !== baseline;
}

function applyReadingFont(family: string): void {
  document.documentElement.style.setProperty(
    '--ema-font-content',
    resolveFontStack(family, READING_FONT_FALLBACK),
  );
}

function applyCodeFont(family: string): void {
  document.documentElement.style.setProperty(
    '--ema-font-mono',
    resolveFontStack(family, CODE_FONT_FALLBACK),
  );
}

function applySyntaxTheme(preset: ThemeSettings['syntaxTheme']): void {
  // 色板只在 foundation/syntax-themes.css, TS 不碰颜色; auto 的深浅分支也在 CSS 里
  document.documentElement.dataset.syntaxTheme = preset;
}

/** 设置 KV 通道不带类型, 这里做入口收窄, 坏字段逐项回落默认而不是整份丢弃. */
const SYNTAX_THEME_VALUES: ReadonlySet<ThemeSettings['syntaxTheme']> = new Set([
  'github', 'onelight', 'solarized-light',
  'tokyonight', 'onedark', 'dracula', 'monokai', 'nord', 'gruvbox', 'catppuccin', 'solarized-dark',
  'mono',
]);

function readThemeValue(value: unknown): ThemeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_THEME_SETTINGS;
  const raw = value as Record<string, unknown>;
  const mode: ThemeSettings['mode'] =
    raw.mode === 'dark' || raw.mode === 'system' ? raw.mode : 'light';
  return {
    hue: typeof raw.hue === 'number' ? raw.hue : DEFAULT_THEME_SETTINGS.hue,
    radius: typeof raw.radius === 'number' ? raw.radius : DEFAULT_THEME_SETTINGS.radius,
    mode,
    readingFont: normalizeLocalFontName(
      typeof raw.readingFont === 'string' ? raw.readingFont : '',
    ),
    codeFont: normalizeLocalFontName(
      typeof raw.codeFont === 'string' ? raw.codeFont : DEFAULT_THEME_SETTINGS.codeFont,
    ),
    syntaxTheme: SYNTAX_THEME_VALUES.has(raw.syntaxTheme as ThemeSettings['syntaxTheme'])
      ? (raw.syntaxTheme as ThemeSettings['syntaxTheme'])
      : 'github',
    hueDynamic: raw.hueDynamic === true,
  };
}

/** dynamic 开启且已取到色时用动态色相; 取不到(null)回退手动色相. */
function effectiveHue(config: ThemeSettings, dynamicHue: number | null): number {
  return config.hueDynamic && dynamicHue !== null ? dynamicHue : config.hue;
}

function applyResolvedTheme(config: ThemeSettings): void {
  setThemeHue(effectiveHue(config, useThemeStore.getState().dynamicHue));
  setThemeRadius(config.radius);
  applyMode(config.mode);
  applyReadingFont(config.readingFont);
  applyCodeFont(config.codeFont);
  applySyntaxTheme(config.syntaxTheme);
}

function applyMode(mode: ThemeSettings['mode']): void {
  // 切换双向动画:切前给 <html> 加 .ema-theme-transition 触发全局 color 过渡,
  // 过渡完(400ms)移除 只过渡颜色不过渡 transform/layout(见 transitions.css)
  const html = document.documentElement;
  html.classList.add('ema-theme-transition');

  const resolved = resolveMode(mode);
  if (resolved === 'dark') {
    document.documentElement.removeAttribute(THEME_ATTR);
  } else {
    document.documentElement.setAttribute(THEME_ATTR, resolved);
  }

  // 同步原生标题栏配色(Tauri 窗口)
  void tauriBridge.setWindowTheme(resolved);

  // 过渡完移除 class(过渡时长 base 200ms + buffer 200ms = 400ms)
  window.setTimeout(() => html.classList.remove('ema-theme-transition'), 400);
}

const prefersDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolveMode(mode: ThemeSettings['mode']): 'light' | 'dark' {
  if (mode === 'system') return prefersDarkQuery.matches ? 'dark' : 'light';
  return mode;
}

// system 档跟随 OS: 系统明暗变化时重应用当前主题, 不写库不广播.
prefersDarkQuery.addEventListener('change', () => {
  if (useThemeStore.getState().mode === 'system') applyMode('system');
});

export interface ThemeStoreState extends ThemeSettings {
  dynamicHue: number | null;
  systemFonts: string[];
  ready:  boolean;

  init(): Promise<void>;
  /** 懒加载本机字体清单: 仅在用户点开字体选择器时拉取一次, 之后 memo; 取不到时保持空表(策展清单兜底). */
  ensureSystemFonts(): Promise<void>;
  setHue(hue: number): Promise<void>;
  setRadius(radius: number): Promise<void>;
  setMode(mode: ThemeSettings['mode']): Promise<void>;
  setReadingFont(family: string): Promise<void>;
  setCodeFont(family: string): Promise<void>;
  setSyntaxTheme(preset: ThemeSettings['syntaxTheme']): Promise<void>;
  setHueDynamic(value: boolean): Promise<void>;
  /** 动态取色结果到达时调用: 只重应用不落库; null 表示取不到色, 回退手动色相. */
  applyDynamicHue(hue: number | null): void;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  ...DEFAULT_THEME_SETTINGS,
  dynamicHue: null,
  systemFonts: [],
  ready: false,

  async init() {
    try {
      const { value } = await settingsApi.getValue(THEME_SETTING_KEY);
      const resolved = readThemeValue(value);
      applyResolvedTheme(resolved);
      set({ ...resolved, ready: true });
    } catch {
      applyResolvedTheme(DEFAULT_THEME_SETTINGS);
      set({ ...DEFAULT_THEME_SETTINGS, ready: true });
    }
  },

  async ensureSystemFonts() {
    if (get().systemFonts.length > 0) return;
    const fonts = await tauriBridge.listSystemFonts();
    if (fonts.length > 0) set({ systemFonts: fonts });
  },

  async setHue(hue) {
    // 滑块连发: 预览立即生效(state 即 ThemeSettings, 无需装配);
    // 落库停歇 200ms 后只做最后一次, pick 只发生在拖动开始与结束时.
    if (pendingHuePrevious === null) pendingHuePrevious = currentThemeValue(get());
    set({ hue });
    applyResolvedTheme(get());
    if (huePersistTimer !== undefined) window.clearTimeout(huePersistTimer);
    huePersistTimer = window.setTimeout(() => {
      huePersistTimer = undefined;
      const previous = pendingHuePrevious;
      pendingHuePrevious = null;
      if (previous) {
        void persistThemeChange(currentThemeValue(get()), previous, value => set(value));
      }
    }, 200);
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

  async setReadingFont(readingFont) {
    const previous = currentThemeValue(get());
    const next = { ...previous, readingFont: normalizeLocalFontName(readingFont) };
    await persistThemeChange(next, previous, value => set(value));
  },

  async setCodeFont(codeFont) {
    const previous = currentThemeValue(get());
    const next = { ...previous, codeFont: normalizeLocalFontName(codeFont) };
    await persistThemeChange(next, previous, value => set(value));
  },

  async setSyntaxTheme(syntaxTheme) {
    const previous = currentThemeValue(get());
    const next = { ...previous, syntaxTheme };
    await persistThemeChange(next, previous, value => set(value));
  },

  async setHueDynamic(hueDynamic) {
    const previous = currentThemeValue(get());
    const next = { ...previous, hueDynamic };
    await persistThemeChange(next, previous, value => set(value));
    if (hueDynamic) {
      void refreshDynamicHue();
    } else {
      set({ dynamicHue: null });
    }
  },

  applyDynamicHue(hue) {
    set({ dynamicHue: hue });
    applyResolvedTheme(currentThemeValue(get()));
  },
}));

function emitTheme(config: ThemeSettings): void {
  void tauriBridge.publishThemeChanged(config);
}

// setHue 防抖落库: 一次拖动只记开始前的回滚点与定时器.
let huePersistTimer: number | undefined;
let pendingHuePrevious: ThemeSettings | null = null;

/** dynamic 开启时重新采样当前角色立绘主色; 采样失败回退手动色相(applyDynamicHue(null)). */
async function refreshDynamicHue(): Promise<void> {
  useThemeStore.getState().applyDynamicHue(await sampleActiveCharacterHue());
}

function currentThemeValue(state: ThemeStoreState): ThemeSettings {
  return {
    hue: state.hue,
    radius: state.radius,
    mode: state.mode,
    readingFont: state.readingFont,
    codeFont: state.codeFont,
    syntaxTheme: state.syntaxTheme,
    hueDynamic: state.hueDynamic,
  };
}

async function persistThemeChange(
  next: ThemeSettings,
  previous: ThemeSettings,
  updateState: (value: ThemeSettings) => void,
): Promise<void> {
  // 当前窗口先预览 只有 SQLite 提交成功后才通知其他窗口
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

/** 每个 Tauri 窗口根部调用一次: 挂载时取回并应用主题, 监听其他窗口的 theme:changed */
export function useThemeSync(): void {
  useEffect(() => {
    void useThemeStore.getState().init().then(() => {
      if (useThemeStore.getState().hueDynamic) void refreshDynamicHue();
    });

    // 角色切换是动态取色的重采触发点; 只有 hueDynamic 开启才工作.
    const unsubscribeCharacter = useCharacterStore.subscribe((state, prev) => {
      if (state.activeName !== prev.activeName && useThemeStore.getState().hueDynamic) {
        void refreshDynamicHue();
      }
    });

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void tauriBridge.listenThemeChanged((theme) => {
      const resolved = readThemeValue(theme);
      applyResolvedTheme(resolved);
      useThemeStore.setState(resolved);
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); unsubscribeCharacter(); };
  }, []);
}
