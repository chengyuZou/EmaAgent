// 展示并保存主题色、动态取色、圆角、正文字体、等宽字体、代码配色和明暗模式。
import { useEffect, useState, type JSX, type ChangeEvent } from 'react';
import { Button, Select, Slider, Switch, type SelectOption } from '@ema-agent/ui';
import { useThemeStore } from '../../stores/theme.js';
import type { ThemeSettings } from '@ema-agent/server/settings/themeSetting.js';
import {
  RADIUS_STEPS,
  SYNTAX_THEME_OPTIONS,
  COLOR_PALETTES,
  HUE_LADDER_STEPS,
} from '@ema-agent/server/settings/themeCatalog.js';
import { hexToOklch } from '../../lib/oklch.js';

type ThemeMode = ThemeSettings['mode'];

/** 圆角预览块静态映射--UnoCSS 扫不到 `rounded-${size}` 动态拼接，必须完整字面量。 */
const RADIUS_PREVIEW_CLASS: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
};

/* Radix 保留空串为清空值, 系统档用哨兵值, 保存时再翻译回空串. */
const SYSTEM_FONT_VALUE = '__system__';

/** 调色板色值与预提色相: catalog 是常量, 预提一次后渲染零换算. */
const PALETTE_SWATCHES = COLOR_PALETTES.map((palette) => ({
  ...palette,
  swatches: palette.colors.map((hex) => ({ hex, hue: Math.round(hexToOklch(hex)?.h ?? 0) })),
}));

// ── Hue spectrum slider ───────────────────────────────────────────────────────
//
// Native <input type="range"> with a gradient track showing the full hue wheel.
// 色谱轨道与原生滑块伪元素由 styles/domains/appearance.css 提供。

function HueSlider({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (h: number) => void }): JSX.Element {
  return (
    <input
      type="range"
      className="ema-hue-range"
      min={0}
      max={360}
      step={1}
      value={value}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
      aria-label="色相"
    />
  );
}

/** 字体选择行: "系统默认"置顶, 横线之下是本机字体全表(点开选择器时才懒加载). */
function FontFamilyField({ family, systemLabel, systemFonts, onSave, onLazyLoad }: {
  family: string;
  systemLabel: string;
  systemFonts: string[];
  onSave(family: string): void;
  onLazyLoad(): void;
}): JSX.Element {
  const known = family === '' || systemFonts.includes(family);
  const selectOptions: SelectOption[] = [
    { value: SYSTEM_FONT_VALUE, label: systemLabel },
    ...(known ? [] : [{ value: family, label: `${family}(本机未安装)` }]),
    ...systemFonts.map((name, index) => ({
      value: name,
      label: name,
      ...(index === 0 ? { separatorAbove: true } : {}),
    })),
  ];
  return (
    <div onPointerDownCapture={onLazyLoad} onFocusCapture={onLazyLoad}>
      <Select
        value={family === '' ? SYSTEM_FONT_VALUE : family}
        onChange={(value) => onSave(value === SYSTEM_FONT_VALUE ? '' : value)}
        options={selectOptions}
      />
    </div>
  );
}

// ── AppearanceTab ─────────────────────────────────────────────────────────────

export function AppearanceTab(): JSX.Element {
  const {
    hue,
    radius,
    mode,
    readingFont,
    codeFont,
    syntaxTheme,
    hueDynamic,
    ready,
    init,
    systemFonts,
    ensureSystemFonts,
    setHue,
    setRadius,
    setMode,
    setReadingFont,
    setCodeFont,
    setSyntaxTheme,
    setHueDynamic,
  } = useThemeStore();
  const [shaking, setShaking] = useState<ThemeMode | null>(null);

  // 点当前已激活的主题按钮 -> shake 反馈(不 disabled,用户要知道点了)
  function handleModeClick(target: ThemeMode): void {
    if (mode === target) {
      setShaking(target);
      window.setTimeout(() => setShaking(null), 400);
      return;
    }
    void setMode(target);
  }

  useEffect(() => {
    if (!ready) void init();
  }, [ready, init]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">外观</h2>

      {/* ── Color ── */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">主题色</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">拖动选择任意色相，辅色(紫罗兰)会自动跟随</p>
        </div>

        <HueSlider value={hue} disabled={hueDynamic} onChange={(h) => void setHue(h)} />

        {/* 当前色相的 11 级明度板, 拖滑块时实时跟随 */}
        <div className="flex overflow-hidden rounded-lg border border-[var(--ema-border)]">
          {HUE_LADDER_STEPS.map((step) => (
            <div
              key={step.label}
              className="flex h-8 flex-1 items-center justify-center text-[10px] font-medium"
              style={{
                background: `oklch(${step.lightness} ${step.chroma} ${hue})`,
                color: step.lightness > 0.62 ? 'oklch(0.35 0.02 280)' : 'oklch(0.95 0.02 280)',
              }}
            >
              {step.label}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--ema-text-secondary)]">动态取色</p>
            <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
              主题色跟随角色立绘主色{hueDynamic ? '；开启时手动选择暂不生效' : ''}
            </p>
          </div>
          <Switch
            checked={hueDynamic}
            label="动态取色"
            onCheckedChange={(value) => void setHueDynamic(value)}
          />
        </div>

      </section>

      {/* 调色预设: 每套一张行卡, 左标题一行流, 右色点. */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-2">
        <div className="pb-1">
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">调色预设</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">策展调色板，点击色块取其色相</p>
        </div>
        {PALETTE_SWATCHES.map((palette) => (
          <div
            key={palette.id}
            className="flex items-center justify-between gap-4 rounded-lg bg-[var(--ema-surface-2)] px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--ema-text-secondary)]">{palette.label}</p>
              <p className="text-xs text-[var(--ema-text-tertiary)] truncate">{palette.description}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {palette.swatches.map(({ hex, hue: swatchHue }) => {
                const selected = Math.abs(hue - swatchHue) < 8 || Math.abs(hue - swatchHue) > 352;
                return (
                  <Button
                    key={hex}
                    variant="ghost"
                    size="sm"
                    title={hex}
                    onClick={() => void setHue(swatchHue)}
                    className="p-0 h-auto border-transparent bg-transparent hover:bg-transparent active:bg-transparent"
                  >
                    <span
                      className={`block w-6 h-6 rounded-full border-2 transition-ema hover:border-[var(--ema-primary)]/50 ${
                        selected
                          ? 'border-[var(--ema-border-strong)] shadow-[var(--ema-shadow-1)]'
                          : 'border-transparent'
                      }`}
                      style={{ background: hex }}
                    />
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </section>


      {/* ── Shape ── */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">圆角风格</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">调整按钮、卡片、弹窗的圆角程度</p>
        </div>

        <Slider<number>
          value={radius}
          onChange={(r: number) => void setRadius(r)}
          steps={RADIUS_STEPS}
        />

        {/* Shape preview: 四档撑满整行, 直观对比圆角量级. */}
        <div className="flex gap-3 pt-2">
          {(['sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <div
              key={size}
              className={`h-14 flex-1 ${RADIUS_PREVIEW_CLASS[size]} bg-[var(--ema-primary-muted)] border border-[var(--ema-primary)]`}
            />
          ))}
        </div>
      </section>

      {/* 正文字体只管 Markdown 正文与长文本, 不影响界面控件、代码块和公式。 */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">Markdown 正文字体</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
            调整聊天正文和长文本的阅读观感，代码仍使用等宽字体
          </p>
        </div>

        <FontFamilyField
          family={readingFont}
          systemLabel="跟随系统"
          systemFonts={systemFonts}
          onSave={(value) => void setReadingFont(value)}
          onLazyLoad={() => void ensureSystemFonts()}
        />

        <div className="markdown-content rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3 text-sm text-[var(--ema-text-primary)]">
          Ema 会用这种字体显示 Markdown 正文。The quick brown fox jumps over the lazy dog.
        </div>
      </section>


      {/* 等宽字体只管代码/JSON/终端/工具行, 不影响界面控件与正文。 */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">等宽字体</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
            代码块、工具参数和终端使用的字体，界面其余部分不受影响
          </p>
        </div>

        <FontFamilyField
          family={codeFont}
          systemLabel="跟随系统等宽"
          systemFonts={systemFonts}
          onSave={(value) => void setCodeFont(value)}
          onLazyLoad={() => void ensureSystemFonts()}
        />

        <div className="rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3 font-mono text-xs text-[var(--ema-text-secondary)]">
          const ema = '代码 / JSON / 终端用这种字体显示'; // 0123456789
        </div>
      </section>


      {/* 代码配色只管语法高亮, 色板在 src/ui/styles/foundation/syntax-themes.css。 */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">代码配色</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
            代码块和 JSON 的语法高亮配色，跟随主题会按明暗自动切换
          </p>
        </div>

        <Select
          value={syntaxTheme}
          onChange={(value) => void setSyntaxTheme(value as ThemeSettings['syntaxTheme'])}
          options={SYNTAX_THEME_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        />

        <div className="markdown-content">
          <pre>
            <span style={{ color: 'var(--ema-syntax-comment)' }}>// 实时预览: 语法色板全色样</span>{'\n'}
            <span style={{ color: 'var(--ema-syntax-key)' }}>const</span>
            <span style={{ color: 'var(--ema-text-primary)' }}> ema = </span>
            <span style={{ color: 'var(--ema-syntax-string)' }}>'语法高亮'</span>
            <span style={{ color: 'var(--ema-text-primary)' }}>;</span>{'\n'}
            <span style={{ color: 'var(--ema-syntax-key)' }}>const</span>
            <span style={{ color: 'var(--ema-text-primary)' }}> enabled = </span>
            <span style={{ color: 'var(--ema-syntax-boolean)' }}>true</span>
            <span style={{ color: 'var(--ema-text-primary)' }}>;</span>{'\n'}
            <span style={{ color: 'var(--ema-syntax-key)' }}>if</span>
            <span style={{ color: 'var(--ema-text-primary)' }}> (ema && enabled) total += </span>
            <span style={{ color: 'var(--ema-syntax-number)' }}>1000</span>
            <span style={{ color: 'var(--ema-text-primary)' }}>;</span>
          </pre>
        </div>
      </section>


      {/* ── Mode ── */}
      <section className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">显示模式</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">切换深色 / 浅色主题，文字与背景自动适配</p>
        </div>

        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => handleModeClick('dark')}
            className={`flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--grid ${
              mode === 'dark'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }${shaking === 'dark' ? ' ema-shake' : ''}`}
          >
            <span className="i-solar:moon-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">深色</span>
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleModeClick('light')}
            className={`flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--grid ${
              mode === 'light'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }${shaking === 'light' ? ' ema-shake' : ''}`}
          >
            <span className="i-solar:sun-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">浅色</span>
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleModeClick('system')}
            className={`flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--grid ${
              mode === 'system'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }${shaking === 'system' ? ' ema-shake' : ''}`}
          >
            <span className="i-solar:monitor-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">跟随系统</span>
          </Button>
        </div>
      </section>
    </div>
  );
}
