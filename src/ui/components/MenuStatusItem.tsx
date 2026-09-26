import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── MenuStatusItem ───────────────────────────────────────────────────────────
//
// Provider 网格卡: 标题+描述, 灰度图标从右缘探出(hover 回色), 左上角配置状态点.
// 装饰(hover 扫光+纹理)统一走 ema-card-decorate primitive, 不在组件里手写伪元素.
//
// 结构保持扁平: icon 直接放在 button 里, 只有一层 overflow-hidden 裁剪,
// 右缘探出效果与主菜单卡一致.

export interface MenuStatusItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title:        string;
  description?: string;
  /** UnoCSS icon class, e.g. "i-mdi:robot-outline". */
  icon?:        string;
  /** Custom icon colour class appended to the icon (e.g. "text-[var(--ema-success)]"). */
  iconColor?:   string;
  /** Filled green dot when true, hollow ring when false. */
  configured?:  boolean;
}

export function MenuStatusItem(props: MenuStatusItemProps): React.JSX.Element {
  const { title, description, icon, iconColor, configured = false, className, ...rest } = props;

  return (
    <button
      type="button"
      className={cn(
        'group relative w-full h-full flex flex-col overflow-hidden box-border text-left cursor-pointer',
        'ema-card-decorate ema-card-decorate--grid',
        'rounded-xl bg-[var(--ema-surface-1)] ema-glass-weak border border-solid border-[var(--ema-border)]',
        'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
        'active:scale-[0.97]',
        'transition-ema',
        className,
      )}
      {...rest}
    >
      {/* Text (padded like a card; 左侧留白给状态点) */}
      <div className="relative z-1 flex-1 min-w-0 p-5 pb-3 pl-9">
        <div className="text-lg font-semibold text-[var(--ema-text-primary)] group-hover:text-[var(--ema-primary-text)] transition-ema truncate">
          {title}
        </div>
        <div className="text-sm text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary-text)]/80 transition-ema truncate">
          {description ?? ''}
        </div>
      </div>

      {/* Icon — same strategy as MenuIconItem: peeks from right edge, centred vertically */}
      {icon && (
        <div
          aria-hidden
          className={cn(
            icon,
            'absolute right-0 top-1/2 -translate-y-1/2 size-16 opacity-40',
            'text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary)] group-hover:opacity-70 group-hover:scale-[1.2]',
            'transition-ema',
            iconColor,
          )}
        />
      )}

      {/* Status dot — 左上角 */}
      <div className="absolute left-2 top-2 z-1">
        {configured
          ? <div className="size-3.5 rounded-full bg-[var(--ema-success)] shadow-[var(--ema-shadow-1)]" />
          : <div className="size-3.5 rounded-full bg-[var(--ema-surface-2)] border-2 border-solid border-[var(--ema-border-strong)]" />}
      </div>
    </button>
  );
}
