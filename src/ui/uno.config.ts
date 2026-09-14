// ── EmaAgent 共享 UnoCSS preset ─────────────────────────────────────────────
//
// 设计 token 单一事实源。消费方:
//   - src/ui            (组件库 + Ladle stories)
//   - packages/desktop-ui    (业务组件)
//   - apps/desktop           (主窗口 + 子窗口)
//
// 下游 uno.config.ts 用法:
//
//   import { defineConfig } from 'unocss';
//   import { emaSharedPreset } from '@ema-agent/ui/uno.config';
//   export default defineConfig({
//     presets: [...emaSharedPreset()],
//     content: { pipeline: { include: [/src\/.*\.(t|j)sx?$/] } },
//   });
//
// 注意:不要在这里加应用专属 safelist 或 content 通配——本文件全工作区共享,
// 应用专属内容属于各应用自己的 uno.config.ts。

// preset 要从各自的包导入,不走 `unocss` 聚合入口——聚合入口会 re-export 全部
// transformer,而 transformer-attributify-jsx 会把 oxc-parser 的 wasm binding
// 拖进 Vite 的浏览器模块图(unocss vite 插件会把本配置文件注入该图做 HMR)。
import type { Preset, UserConfig } from '@unocss/core';
import presetAttributify from '@unocss/preset-attributify';
import presetIcons from '@unocss/preset-icons';
import presetTypography from '@unocss/preset-typography';
import presetWind3 from '@unocss/preset-wind3';
import {
  createPresetChromatic,
  EMA_PRIMARY_HUE,
  EMA_VIOLET_OFFSET,
  VAR_HUE,
  VAR_RADIUS,
} from './uno-preset-chromatic.js';

/**
 * 通用圆角刻度——引用 tokens.css 的 --ema-radius-* 变量,
 * Uno rounded-* 与手写 CSS 吃同一个 --ema-radius 倍率。pill/full 固定不缩放。
 */
export const RADIUS_SCALE = {
  sm:      'var(--ema-radius-sm)',    // 标签、圆点徽标、小 chip
  DEFAULT: 'var(--ema-radius-xs)',    // 裸 rounded - 最小默认圆角
  md:      'var(--ema-radius-md)',    // 居中档,排版组件(pre 等)与散件用
  lg:      'var(--ema-radius-lg)',    // 按钮与小浮件
  xl:      'var(--ema-radius-xl)',    // 卡片、对话框、浮层、主窗口
  pill:    'var(--ema-radius-pill)',  // pill 按钮 - 固定 999px
  full:    '50%',                     // 圆形图标钮、圆点、头像
} as const;

/**
 * 文本字体栈——引用 tokens.css 变量,Uno font-mono/font-sans
 * 与 CSS var(--ema-font-*) 解析到同一组字。
 */
export const FONT_FAMILY = {
  sans: 'var(--ema-font-ui)',
  mono: 'var(--ema-font-mono)',
} as const;

// ── Safelist ────────────────────────────────────────────────────────────────

/**
 * 静态扫描推不出来的动态颜色类在这里强制生成。没有它,运行时拼出来的类
 * (如 `bg-primary-${level}`)不会出现在最终 CSS 里。
 *
 * 保持克制——这里每加一条都会增加 CSS 体积。
 */
function buildSafelist(): string[] {
  const out: string[] = [];

  // primary / violet 全刻度 × 常用工具
  const scales = ['50','100','200','300','400','500','600','700','800','900','950'];
  const utilities = ['bg', 'text', 'border', 'ring'];
  const opacities = ['', '/10', '/20', '/30', '/50', '/70', '/80'];

  for (const color of ['primary', 'violet']) {
    for (const util of utilities) {
      for (const s of scales) {
        for (const o of opacities) {
          out.push(`${util}-${color}-${s}${o}`);
        }
      }
    }
  }

  // Callout / Badge 用的状态色
  for (const sem of ['green', 'red', 'amber', 'sky']) {
    for (const s of ['100', '500', '900']) {
      out.push(`bg-${sem}-${s}/20`);
      out.push(`text-${sem}-${s}`);
      out.push(`border-${sem}-${s}/40`);
    }
  }

  return out;
}

// ── preset 本体 ─────────────────────────────────────────────────────────────

/**
 * 返回 preset 数组 + theme + safelist + shortcuts,供下游 defineConfig 展开。
 * 返回工厂而非成品配置,是为了让每个消费方能加自己的 content 通配与额外 preset。
 */
export interface EmaSharedPresetOptions {
  /** 额外图标集(如 lobe-icons 经 createExternalPackageIconLoader)。 */
  iconCollections?: Record<string, unknown>;
}

export function emaSharedPreset(options: EmaSharedPresetOptions = {}): Preset[] {
  const chromatic = createPresetChromatic();
  return [
    presetWind3({
      // Tailwind v3 兼容。不开 prefersColor: 'media',
      // 暗色模式由 class 驱动(根元素 .dark 切换)。
      dark: 'class',
    }),
    // OKLCH 动态色板——主色(water-blue)与 violet 都由同一个 hue 变量派生,
    // 运行时修改 --chromatic-hue 同时驱动两套色阶。
    chromatic({
      baseHue: EMA_PRIMARY_HUE,
      colors: {
        primary: 0,                // 保持 EMA_PRIMARY_HUE (200 = water-blue)
        violet:  EMA_VIOLET_OFFSET, // 200 + 85 = 285 = violet
      },
    }) as unknown as Preset,
    // 仅识别 un-* 属性,避免把 React 的 icon/items/options props 误判成工具类。
    presetAttributify({ prefixedOnly: true, prefix: 'un-' }),
    presetIcons({
      scale: 1.2,
      warn:  true,
      extraProperties: {
        'display':         'inline-block',
        'vertical-align':  'middle',
      },
      ...(options.iconCollections
        ? { collections: options.iconCollections as never }
        : {}),
    }),
    presetTypography({
      cssExtend: {
        'pre': { 'border-radius': RADIUS_SCALE.md },
        'code': { 'border-radius': RADIUS_SCALE.sm },
      },
    }),
    // -- 通用 box-sizing reset --
    //
    // UnoCSS(与 Tailwind 的 `@tailwind base` 不同)不会自动注入这条。
    // 没有它,表单元素(textarea/input/select/button)回落到 UA 样式表的
    // content-box,w-full + px-* 内边距会加在声明宽度之外——元素悄悄比父级宽。
    // 当年追了一整个下午的"幽灵圆角框"(ChatInput textarea 旁)就是这个溢出
    // (见 2026-06-16 聊天记录)。
    {
      name: 'ema-reset',
      preflights: [
        {
          getCSS: () => `*, ::before, ::after { box-sizing: border-box; }`,
        },
      ],
    },
    // -- 形状系统:--ema-radius 运行时缩放所有 rounded-* --
    // 事实源在 tokens.css;这个 preflight 只保证变量在不加载 desktop-ui
    // 样式的环境(如 Ladle)里也存在。
    {
      name: 'ema-shape',
      preflights: [
        {
          getCSS: () => `:root { ${VAR_RADIUS}: 1; }`,
        },
      ],
    },
    // -- 自定义动画:注册成 theme 条目,animate-* Uno 工具类可用。
    //    @keyframes 只住在 styles/keyframes.css。
    {
      name: 'ema-animations',
      theme: {
        animation: {
          'fade-in':     'ema-fade-in     150ms ease-out both',
          'fade-out':    'ema-fade-out    100ms ease-in  forwards',
          'scale-in':    'ema-scale-in    150ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-up':    'ema-slide-up    220ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-down':  'ema-slide-down  220ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-right': 'ema-slide-right 220ms cubic-bezier(0.16,1,0.3,1) both',
          'slide-left':  'ema-slide-left  220ms cubic-bezier(0.16,1,0.3,1) both',
          // Progress 流光(Progress 组件专用;@keyframes 在下方 preflight 定义)
          'progress-shine': 'progress-shine 2s cubic-bezier(0.35,0.08,0.04,0.99) infinite',
        },
      },
      preflights: [
        {
          // progress-shine 是 Progress 组件专用,不进 styles/keyframes.css。
          getCSS: () => `
@keyframes progress-shine {
  0%   { opacity: 0.4; transform: scale(0, 1); }
  100% { opacity: 0;   transform: scale(1, 1); }
}
          `.trim(),
        },
      ],
    },
  ];
}

/**
 * 共享 theme 对象——`colors`、`borderRadius`、`fontFamily`。
 * 展开到消费方的 defineConfig({ theme: { ... } })。
 */
export function emaSharedTheme() {
  return {
    // primary + violet 色板由 emaSharedPreset() 的 chromatic preset 注入。
    // 不要在这里重复声明——UnoCSS 里显式 theme key 会覆盖 preset theme key,
    // 会把基于 CSS 变量的 oklch() 表达式屏蔽掉。
    borderRadius: RADIUS_SCALE,
    fontFamily:   FONT_FAMILY,
  };
}

/** 全局可用的快捷方式类。 */
export function emaSharedShortcuts() {
  return {
    // 毛玻璃面板——浮动 dock、popover、dialog
    'panel-glass': 'bg-[var(--ema-surface-4)] backdrop-blur-md border border-[var(--ema-border)] shadow-lg',
    // 面板内嵌卡片的轻玻璃(设置卡、provider 网格)
    'card-glass': 'bg-[var(--ema-surface-2)] backdrop-blur-sm border border-[var(--ema-border)]',
    // 可聚焦元素的焦点环(token 驱动,亮暗自适应)。
    // 2px 实心环(72% primary)贴边无 offset 缝 + 3px 同色 12% 光晕——与四控件方案 B 同配方;
    // 旧版 ring-offset-2 会在环与元素之间塞一条底色缝,焦点框与发光对不上。
    'focus-ring': 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--ema-primary)_72%,transparent)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ema-primary)_12%,transparent)]',
    // 标准交互动效——只覆盖视觉属性,不碰 layout(transform 给 hover/press 缩放留路)
    'transition-ema': 'transition-[background-color,border-color,color,fill,stroke,box-shadow,transform,opacity] duration-250 ease-in-out',
    // 按压反馈(沿用现有手感,数值不做全局并轨)
    'press':    'active:scale-[0.95] transition-transform duration-100',
    'press-sm': 'active:scale-[0.98] transition-transform duration-100',
    // chat 域控件皮肤(设想稿语言):组件(Button/IconButton)照常渲染,皮肤由 shortcut 承担。
    // 厚条(新对话):38px、rounded-xl、有底有边有影。
    'chat-bar-btn': 'flex items-center justify-center gap-1.5 w-full h-9.5 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-3)] text-[var(--ema-text-primary)] text-[13px] shadow-[var(--ema-shadow-1)] hover:bg-[var(--ema-surface-4)] hover:border-[var(--ema-primary)]/30',
    // 裸态小矩形钮:默认无底无边,hover 显底(消息动作/Header/Panel 顶栏/composer 底栏通用);
    // aria-pressed 为切换钮的"开"态(TTS 等),常驻 muted 底。
    'chat-icon-btn': 'inline-flex items-center justify-center size-7.5 rounded-[9px] border border-transparent bg-transparent text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)] aria-pressed:bg-[var(--ema-primary-muted)] aria-pressed:text-[var(--ema-primary-text)] aria-pressed:border-[var(--ema-primary)]/40',
    // 行内动作:裸态+随行 hover/focus-within 浮现;菜单打开时也保持可见。
    'chat-row-action': 'chat-icon-btn size-5.5 rounded-md opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
    // 选择器小矩形(纯文本 pill):KB/Max/模型;权限那颗自行加盾 icon。
    'chat-btn': 'inline-flex items-center gap-1 h-7.5 px-2.5 rounded-[9px] border border-[var(--ema-border)] bg-[var(--ema-surface-3)] text-[var(--ema-text-secondary)] text-[11px] font-medium shadow-[var(--ema-shadow-1)] hover:bg-[var(--ema-surface-4)] hover:text-[var(--ema-text-primary)] hover:border-[var(--ema-primary)]/30',
  };
}

/** safelist 导出——原因见 buildSafelist 注释。 */
export const emaSharedSafelist = buildSafelist();

// ── 本包自用配置(Ladle 预览用) ──────────────────────────────────────────────

const config: UserConfig = {
  presets:   emaSharedPreset(),
  theme:     emaSharedTheme(),
  shortcuts: emaSharedShortcuts(),
  safelist:  emaSharedSafelist,
  content: {
    pipeline: {
      include: [/src\/.*\.(t|j)sx?$/],
    },
  },
};

export default config;
