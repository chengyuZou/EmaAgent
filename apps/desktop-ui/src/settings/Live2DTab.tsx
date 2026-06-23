// TODO: Live2D 舞台设置（scale / position / FPS / 行为开关）暂未实现，V1.5 再补。
/** Live2DTab — Live2D model selection (V1 minimal). */
import { Badge } from '@ema-agent/ui';

export function Live2DTab(): JSX.Element {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-3 text-[var(--ema-text-primary)]">Live2D 模型</h2>
      <div className="text-sm" style={{ color: 'var(--ema-text-tertiary)' }}>
        V1 暂不支持模型上传。当前使用内置 Ema 模型。
      </div>
      <div
        className="mt-4 flex items-center gap-3 rounded-xl px-4 py-3 border ema-glass-weak"
        style={{ background: 'var(--ema-surface-1)', borderColor: 'var(--ema-border)' }}
      >
        <div className="w-2 h-2 rounded-full" style={{ background: 'var(--ema-success)' }} />
        <span className="text-sm font-medium text-[var(--ema-text-primary)]">ema-v1</span>
        <Badge variant="neutral">内置</Badge>
      </div>
    </div>
  );
}
