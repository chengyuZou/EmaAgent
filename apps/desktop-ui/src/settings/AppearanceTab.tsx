import { useEffect, type JSX, type ChangeEvent } from 'react';
import { Slider, type SliderStep } from '@ema-agent/ui';
import { useThemeStore } from '../stores/theme-store.js';

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

// ── Hue spectrum slider ───────────────────────────────────────────────────────
//
// Native <input type="range"> with a gradient track showing the full hue wheel.
// Styled via inline CSS + webkit/moz pseudo-element overrides injected once.

const HUE_TRACK_GRADIENT =
  'linear-gradient(to right, oklch(65% 0.18 0), oklch(65% 0.18 60), oklch(65% 0.18 120), oklch(65% 0.18 180), oklch(65% 0.18 240), oklch(65% 0.18 300), oklch(65% 0.18 360))';

function HueSlider({ value, onChange }: { value: number; onChange: (h: number) => void }): JSX.Element {
  return (
    <>
      <style>{`
        .ema-hue-range { -webkit-appearance: none; appearance: none; width: 100%; height: 12px; border-radius: 9999px; outline: none; cursor: pointer; background: ${HUE_TRACK_GRADIENT}; }
        .ema-hue-range::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: white; border: 2px solid rgba(255,255,255,0.8); box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: pointer; transition: transform 0.15s; }
        .ema-hue-range::-webkit-slider-thumb:hover { transform: scale(1.15); }
        .ema-hue-range::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; background: white; border: 2px solid rgba(255,255,255,0.8); box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: pointer; }
        .ema-hue-range::-moz-range-track { height: 12px; border-radius: 9999px; background: ${HUE_TRACK_GRADIENT}; }
      `}</style>
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
    </>
  );
}

// ── AppearanceTab ─────────────────────────────────────────────────────────────

export function AppearanceTab(): JSX.Element {
  const { hue, radius, mode, ready, init, setHue, setRadius, setMode } = useThemeStore();

  useEffect(() => {
    if (!ready) void init();
  }, [ready, init]);

  return (
    <div className="space-y-8 max-w-lg">
      <h2 className="text-base font-semibold" style={{ color: 'var(--ema-text-primary)' }}>外观</h2>

      {/* ── Color ── */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--ema-text-secondary)' }}>主题色</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ema-text-tertiary)' }}>拖动选择任意色相，辅色(紫罗兰)会自动跟随</p>
        </div>

        {/* Continuous hue slider */}
        <HueSlider value={hue} onChange={(h) => void setHue(h)} />

        {/* Preset swatches */}
        <div className="flex flex-wrap gap-2 pt-1">
          {HUE_PRESETS.map((p) => (
            <button
              key={p.hue}
              title={p.label}
              onClick={() => void setHue(p.hue)}
              className="group flex flex-col items-center gap-1"
            >
              <span
                className="block w-7 h-7 rounded-full border-2 transition-ema hover:scale-110"
                style={{
                  background: `oklch(65% 0.18 ${p.hue})`,
                  borderColor: Math.abs(hue - p.hue) < 5 ? 'white' : 'transparent',
                  boxShadow:   Math.abs(hue - p.hue) < 5 ? '0 0 0 1px rgba(255,255,255,0.3)' : 'none',
                }}
              />
              <span className="text-xs transition-ema"
                    style={{ color: 'var(--ema-text-tertiary)' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-primary)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-tertiary)'; }}>
                {p.label}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="border-t" style={{ borderColor: 'var(--ema-border)' }} />

      {/* ── Shape ── */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--ema-text-secondary)' }}>圆角风格</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ema-text-tertiary)' }}>调整按钮、卡片、弹窗的圆角程度</p>
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
              className={`w-12 h-12 rounded-${size}`}
              style={{ background: 'var(--ema-primary-muted)', borderColor: 'var(--ema-primary)', borderWidth: 1 }}
            />
          ))}
        </div>
      </section>

      <div className="border-t" style={{ borderColor: 'var(--ema-border)' }} />

      {/* ── Mode ── */}
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--ema-text-secondary)' }}>显示模式</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ema-text-tertiary)' }}>切换深色 / 浅色主题，文字与背景自动适配</p>
        </div>

        <div className="flex items-center gap-4">
          {/* V1.5: 深色模式暂未想好配置方案，按钮先注释
          <button
            onClick={() => void setMode('dark')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all duration-[var(--ema-duration-base)] ${
              mode === 'dark'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }`}
          >
            <span className="i-solar:moon-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">深色</span>
          </button>
          */}
          <button
            onClick={() => void setMode('light')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all duration-[var(--ema-duration-base)] ${
              mode === 'light'
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)]'
                : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-tertiary)] hover:border-[var(--ema-border-hover)]'
            }`}
          >
            <span className="i-solar:sun-bold-duotone text-lg" aria-hidden />
            <span className="text-sm font-medium">浅色</span>
          </button>
        </div>
      </section>
    </div>
  );
}
