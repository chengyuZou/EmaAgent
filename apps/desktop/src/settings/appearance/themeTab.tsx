import { useState, type JSX, type ChangeEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Select, Slider, Switch } from '@ema-agent/ui';
import { useThemeStore } from '../../stores/theme.js';
import { PageHeader } from '../shared/PageHeader.js';
import type { ThemeSettings } from '@ema-agent/server/settings/themeSetting.js';
import {
  RADIUS_STEPS,
  SYNTAX_THEME_OPTIONS,
  COLOR_PALETTES,
  HUE_LADDER_STEPS,
} from '@ema-agent/server/settings/themeCatalog.js';
import { hexToOklch } from '../../lib/oklch.js';

type ThemeMode = ThemeSettings['mode'];

// UnoCSS 无法扫描动态拼接的圆角类名, 这里保留完整字面量.
const RADIUS_PREVIEW_CLASS: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
};

// 调色板是常量, 色相只需在首次加载时换算一次.
const PALETTE_SWATCHES = COLOR_PALETTES.map((palette) => ({
  ...palette,
  swatches: palette.colors.map((hex) => ({ hex, hue: Math.round(hexToOklch(hex)?.h ?? 0) })),
}));

function HueSlider({ value, disabled, onChange }: {
  value: number;
  disabled?: boolean;
  onChange(hue: number): void;
}): JSX.Element {
  return (
    <input
      type="range"
      className="ema-hue-range"
      min={0}
      max={360}
      step={0.1}
      value={value}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
      aria-label="色相"
    />
  );
}

// 拖动色相时只重绘色带和预设选中态, 不重绘其余主题设置.
function ThemeColorSection(): JSX.Element {
  const hue = useThemeStore(state => state.hue);
  const hueDynamic = useThemeStore(state => state.hueDynamic);
  const setHue = useThemeStore(state => state.setHue);
  const setHueDynamic = useThemeStore(state => state.setHueDynamic);

  return (
    <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
      <div>
        <p className="text-sm font-medium text-[var(--ema-text-secondary)]">主题色</p>
        <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">拖动选择任意色相，辅色(紫罗兰)会自动跟随</p>
      </div>

      <HueSlider
        value={hue}
        disabled={hueDynamic}
        onChange={value => void setHue(value)}
      />

      <div className="flex overflow-hidden rounded-lg border border-[var(--ema-border)]">
        {HUE_LADDER_STEPS.map(step => (
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
            主题色跟随角色立绘主色{hueDynamic ? ' 开启时手动选择暂不生效' : ''}
          </p>
        </div>
        <Switch
          checked={hueDynamic}
          label="动态取色"
          onCheckedChange={value => void setHueDynamic(value)}
        />
      </div>
    </section>
  );
}

function PaletteSection(): JSX.Element {
  const hue = useThemeStore(state => state.hue);
  const setHue = useThemeStore(state => state.setHue);

  return (
    <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-2">
      <div className="pb-1">
        <p className="text-sm font-medium text-[var(--ema-text-secondary)]">调色预设</p>
        <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">策展调色板，点击色块取其色相</p>
      </div>
      {PALETTE_SWATCHES.map(palette => (
        <div
          key={palette.id}
          className="ema-material-card flex items-center justify-between gap-4 rounded-lg bg-[var(--ema-surface-2)] px-4 py-4"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--ema-text-secondary)]">{palette.label}</p>
            <p className="text-xs text-[var(--ema-text-tertiary)] truncate">{palette.description}</p>
          </div>
          <div className="flex shrink-0 gap-2.5">
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
                    className={`block h-8 w-8 rounded-full border-2 transition-ema hover:border-[var(--ema-primary)]/50 ${
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
  );
}

export function ThemeTab(): JSX.Element {
  const {
    radius,
    mode,
    syntaxTheme,
    setRadius,
    setMode,
    setSyntaxTheme,
  } = useThemeStore(useShallow(state => ({
    radius: state.radius,
    mode: state.mode,
    syntaxTheme: state.syntaxTheme,
    setRadius: state.setRadius,
    setMode: state.setMode,
    setSyntaxTheme: state.setSyntaxTheme,
  })));
  const [shaking, setShaking] = useState<ThemeMode | null>(null);

  // 重复点击当前模式时给出短暂反馈, 不重复保存相同设置.
  function handleModeClick(target: ThemeMode): void {
    if (mode === target) {
      setShaking(target);
      window.setTimeout(() => setShaking(null), 400);
      return;
    }
    void setMode(target);
  }

  return (
    <div className="mx-auto flex w-[100%] flex-col gap-5">
      <PageHeader
        title="主题"
        description="主题色、动态取色、圆角、代码配色与显示模式"
      />

      <ThemeColorSection />
      <PaletteSection />

      <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">圆角风格</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">调整按钮、卡片、弹窗的圆角程度</p>
        </div>

        <Slider<number>
          value={radius}
          onChange={(r: number) => void setRadius(r)}
          steps={RADIUS_STEPS}
        />

        <div className="flex gap-3 pt-2">
          {(['sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <div
              key={size}
              className={`h-14 flex-1 ${RADIUS_PREVIEW_CLASS[size]} bg-[var(--ema-primary-muted)] border border-[var(--ema-primary)]`}
            />
          ))}
        </div>
      </section>

      {/* 代码配色只影响语法高亮, 不改变字体. */}
      <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
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
          <pre className="ema-material-code">
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


      <section className="ema-material-section rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">显示模式</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">切换深色 / 浅色主题，文字与背景自动适配</p>
        </div>

        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            data-selected={mode === 'system' || undefined}
            onClick={() => handleModeClick('system')}
            className={`ema-material-card flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--grid ${
              mode === 'system'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }${shaking === 'system' ? ' ema-shake' : ''}`}
          >
            <span className="i-solar:monitor-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">跟随系统</span>
          </Button>
          <Button
            variant="ghost"
            data-selected={mode === 'light' || undefined}
            onClick={() => handleModeClick('light')}
            className={`ema-material-card flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--grid ${
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
            data-selected={mode === 'dark' || undefined}
            onClick={() => handleModeClick('dark')}
            className={`ema-material-card flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--grid ${
              mode === 'dark'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }${shaking === 'dark' ? ' ema-shake' : ''}`}
          >
            <span className="i-solar:moon-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">深色</span>
          </Button>
        </div>
      </section>
    </div>
  );
}
