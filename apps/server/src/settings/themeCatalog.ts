// 外观常量注册表: 前端只消费, 不另行定义这些数据.
// 字体族名以操作系统注册名为准; 中文系统上部分字体注册中文名, 探测不到时用户可改输注册名.
// 本文件必须保持零运行时依赖: 它是唯一允许打进桌面浏览器图的后端文件(见 desktop vite.config alias).
import type { ThemeSettings } from './themeSetting.js';

export const THEME_SETTING_KEY = 'frontend.theme';

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  hue: 200,
  radius: 1,
  mode: 'light',
  readingFont: '',
  codeFont: 'Consolas',
  syntaxTheme: 'github',
  hueDynamic: false,
};

/* 正文字体回退: 族名之后拼系统栈. */
export const READING_FONT_FALLBACK = 'var(--ema-font-content-system)';

/* 等宽字体回退: 雅黑兜中文, generic 收尾. */
export const CODE_FONT_FALLBACK = "ui-monospace, 'Cascadia Code', Consolas, 'Microsoft YaHei', monospace";

export const RADIUS_STEPS: Array<{ value: number; label: string }> = [
  { value: 0,   label: '方形' },
  { value: 1,   label: '默认' },
  { value: 1.5, label: '圆润' },
  { value: 2,   label: '极圆' },
];

export const SYNTAX_THEME_OPTIONS: Array<{ value: ThemeSettings['syntaxTheme']; label: string }> = [
  { value: 'github', label: 'GitHub 亮色' },
  { value: 'onelight', label: 'One Light 亮色' },
  { value: 'solarized-light', label: 'Solarized 亮色' },
  { value: 'tokyonight', label: 'Tokyo Night 夜色' },
  { value: 'onedark', label: 'One Dark' },
  { value: 'dracula', label: 'Dracula 德古拉' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'nord', label: 'Nord 北欧' },
  { value: 'gruvbox', label: 'Gruvbox 复古' },
  { value: 'catppuccin', label: 'Catppuccin 摩卡' },
  { value: 'solarized-dark', label: 'Solarized 深色' },
  { value: 'mono', label: '单色护眼' },
];

/* 命名调色板: 每套一组策展色, 点色块取其色相; 只作快选, 值不落库. */
export const COLOR_PALETTES: Array<{ id: string; label: string; description: string; colors: string[] }> = [
  {
    id: 'morandi', label: '莫兰迪', description: '低饱和灰调, 安静不抢戏',
    colors: ['#A5978B', '#D8CAAF', '#B8B4A7', '#C4BCB1', '#E5DED8', '#9A8F7D', '#BEB5A7', '#C9C0B6'],
  },
  {
    id: 'monet', label: '莫奈', description: '印象派的水光与花园',
    colors: ['#7A9EAF', '#B8C7CC', '#D4B79C', '#8B9D77', '#C7D5CB', '#E6D0B1', '#94A7B1', '#B4C8C3'],
  },
  {
    id: 'japanese', label: '日式', description: '和纸与抹茶的暖大地色',
    colors: ['#D9B48F', '#B5917A', '#8C7A6B', '#A17F5F', '#B98C46', '#C7A252', '#DAB300', '#D19826'],
  },
  {
    id: 'nordic', label: '北欧', description: '冷空气一样的灰蓝',
    colors: ['#9BA7B0', '#C1CBD4', '#A5ADB6', '#8B959E', '#D4DCE4', '#7F8A94', '#B3BCC6', '#98A4AE'],
  },
  {
    id: 'chinese', label: '中式', description: '胭脂/黛蓝/藤黄的撞色',
    colors: ['#E4C6D0', '#A61B29', '#5D513C', '#789262', '#1C0D1A', '#F7C242', '#62A9DD', '#8C4B3C'],
  },
];

/* 色阶预览条的 11 级阶梯: 深浅两端收 chroma 防灰雾, 中间档给足. */
export const HUE_LADDER_STEPS: Array<{ label: string; lightness: number; chroma: number }> = [
  { label: '50',  lightness: 0.965, chroma: 0.05 },
  { label: '100', lightness: 0.925, chroma: 0.09 },
  { label: '200', lightness: 0.87,  chroma: 0.12 },
  { label: '300', lightness: 0.80,  chroma: 0.145 },
  { label: '400', lightness: 0.72,  chroma: 0.165 },
  { label: '500', lightness: 0.65,  chroma: 0.17 },
  { label: '600', lightness: 0.56,  chroma: 0.155 },
  { label: '700', lightness: 0.48,  chroma: 0.135 },
  { label: '800', lightness: 0.40,  chroma: 0.11 },
  { label: '900', lightness: 0.325, chroma: 0.085 },
  { label: '950', lightness: 0.27,  chroma: 0.06 },
];
