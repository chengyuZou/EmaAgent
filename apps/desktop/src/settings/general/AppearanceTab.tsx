// 展示并保存主题颜色、圆角、Markdown 字体和明暗模式。
import { useEffect, useState, type JSX, type ChangeEvent } from 'react';
import { Button, Input, Select, Slider, type SliderStep } from '@ema-agent/ui';
import { useThemeStore } from '../../stores/theme.js';
import type { ThemeSettings } from '@ema-agent/server/composition/settings/themeSetting.js';

type ThemeMode = ThemeSettings['mode'];
type ContentFontPreset = ThemeSettings['contentFontPreset'];

// ── Hue presets ───────────────────────────────────────────────────────────────

const HUE_PRESETS: Array<{ hue: number; label: string }> = [
  { hue: 350, label: '樱粉' },
  { hue: 15,  label: '橙红' },
  { hue: 45,  label: '暖橙' },
  { hue: 155, label: '薄荷' },
  { hue: 220, label: '天空' },
  { hue: 260, label: '蓝紫' },
  { hue: 285, label: '紫罗兰' },
  { hue: 320, label: '玫瑰' },
];

// ── Radius steps ──────────────────────────────────────────────────────────────

const RADIUS_STEPS: SliderStep<number>[] = [
  { value: 0,   label: '方形' },
  { value: 1,   label: '默认' },
  { value: 1.5, label: '圆润' },
  { value: 2,   label: '极圆' },
];

/** 圆角预览块静态映射--UnoCSS 扫不到 `rounded-${size}` 动态拼接，必须完整字面量。 */
const RADIUS_PREVIEW_CLASS: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
};

const CONTENT_FONT_OPTIONS: Array<{ value: ContentFontPreset; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'rounded', label: '柔和圆润' },
  { value: 'reading', label: '人文阅读' },
  { value: 'custom', label: '自定义本地字体' },
];

// ── Hue spectrum slider ───────────────────────────────────────────────────────
//
// Native <input type="range"> with a gradient track showing the full hue wheel.
// Styled via styles/components.css (.ema-hue-range + webkit/moz pseudo-elements).

function HueSlider({ value, onChange }: { value: number; onChange: (h: number) => void }): JSX.Element {
  return (
    <input
      type="range"
      className="ema-hue-range"
      min={0}
      max={360}
      step={1}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
      aria-label="色相"
    />
  );
}

// ── AppearanceTab ─────────────────────────────────────────────────────────────

export function AppearanceTab(): JSX.Element {
  const {
    hue,
    radius,
    mode,
    contentFontPreset,
    contentFontFamily,
    ready,
    init,
    setHue,
    setRadius,
    setMode,
    setContentFont,
  } = useThemeStore();
  const [shaking, setShaking] = useState<ThemeMode | null>(null);
  const [customFontDraft, setCustomFontDraft] = useState(contentFontFamily);

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

  useEffect(() => {
    setCustomFontDraft(contentFontFamily);
  }, [contentFontFamily]);

  function saveCustomFont(): void {
    void setContentFont('custom', customFontDraft);
  }

  return (
    <div className="space-y-8 max-w-lg">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">外观</h2>

      {/* ── Color ── */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">主题色</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">拖动选择任意色相，辅色(紫罗兰)会自动跟随</p>
        </div>

        {/* Continuous hue slider */}
        <HueSlider value={hue} onChange={(h) => void setHue(h)} />

        {/* Preset swatches */}
        <div className="flex flex-wrap gap-2 pt-1">
          {HUE_PRESETS.map((p) => (
            <Button
              key={p.hue}
              variant="ghost"
              size="sm"
              title={p.label}
              onClick={() => void setHue(p.hue)}
              className="group flex-col gap-1 p-0 h-auto border-transparent bg-transparent hover:bg-transparent active:bg-transparent"
            >
              <span
                className={`block w-7 h-7 rounded-full border-2 transition-ema hover:scale-110 ${
                  Math.abs(hue - p.hue) < 5
                    ? 'border-[var(--ema-border-strong)] shadow-[var(--ema-shadow-1)]'
                    : 'border-transparent'
                }`}
                style={{ background: `oklch(65% 0.18 ${p.hue})` }}
              />
              <span className="text-xs transition-ema text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]">
                {p.label}
              </span>
            </Button>
          ))}
        </div>
      </section>

      <div className="border-t border-[var(--ema-border)]" />

      {/* ── Shape ── */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">圆角风格</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">调整按钮、卡片、弹窗的圆角程度</p>
        </div>

        <Slider<number>
          value={radius}
          onChange={(r: number) => void setRadius(r)}
          steps={RADIUS_STEPS}
        />

        {/* Shape preview */}
        <div className="flex gap-3 pt-2">
          {(['sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <div
              key={size}
              className={`w-12 h-12 ${RADIUS_PREVIEW_CLASS[size]} bg-[var(--ema-primary-muted)] border border-[var(--ema-primary)]`}
            />
          ))}
        </div>
      </section>

      <div className="border-t border-[var(--ema-border)]" />

      {/* Markdown 正文字体只影响消息内容，不改变界面控件、代码块和公式。 */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">Markdown 正文字体</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
            调整聊天正文和长文本的阅读观感，代码仍使用等宽字体
          </p>
        </div>

        <Select
          value={contentFontPreset}
          onChange={(value) => void setContentFont(value as ContentFontPreset, customFontDraft)}
          options={CONTENT_FONT_OPTIONS}
        />

        {contentFontPreset === 'custom' && (
          <div className="space-y-1.5">
            <Input
              value={customFontDraft}
              maxLength={80}
              placeholder="输入已安装字体名称，如 LXGW WenKai"
              onChange={(event) => setCustomFontDraft(event.target.value)}
              onBlur={saveCustomFont}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              字体来自本机；其他操作系统未安装时会自动回退到系统字体
            </p>
          </div>
        )}

        <div className="markdown-content rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3 text-sm text-[var(--ema-text-primary)]">
          Ema 会用这种字体显示 Markdown 正文。The quick brown fox jumps over the lazy dog.
        </div>
      </section>

      <div className="border-t border-[var(--ema-border)]" />

      {/* ── Mode ── */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--ema-text-secondary)]">显示模式</p>
          <p className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">切换深色 / 浅色主题，文字与背景自动适配</p>
        </div>

        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => handleModeClick('dark')}
            className={`flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--mesh ${
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
            className={`flex items-center gap-2 px-4 py-2.5 h-auto rounded-xl border transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--mesh ${
              mode === 'light'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }${shaking === 'light' ? ' ema-shake' : ''}`}
          >
            <span className="i-solar:sun-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">浅色</span>
          </Button>
        </div>
      </section>
    </div>
  );
}
