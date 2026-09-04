/** 虚线"添加"占位卡：网格末尾的新建入口（服务来源卡 / 模型卡共用）。 */
import type { JSX } from 'react';

export function AddDashedCard({ label, onClick, compact }: {
  label:    string;
  onClick(): void;
  /** 小尺寸（模型池网格）；默认与 Provider 卡（MenuStatusItem）同高。 */
  compact?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed
                 border-[var(--ema-border)] bg-[var(--ema-surface-1)] cursor-pointer
                 text-[var(--ema-text-tertiary)] outline-none w-full h-full
                 transition-all duration-[var(--ema-duration-base)]
                 hover:border-[var(--ema-primary)]/50 hover:bg-[var(--ema-surface-2)]
                 hover:text-[var(--ema-primary)] active:scale-[0.98]
                 ${compact ? 'rounded-lg min-h-[72px] gap-1.5' : 'gap-1.5 py-3.5'}`}
    >
      <span className={`i-solar:add-circle-bold-duotone ${compact ? 'text-2xl' : 'text-2xl'}`} aria-hidden />
      <span className={`font-medium ${compact ? 'text-[11px]' : 'text-xs'}`}>{label}</span>
    </button>
  );
}
