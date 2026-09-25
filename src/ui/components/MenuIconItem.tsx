import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── MenuIconItem ─────────────────────────────────────────────────────────────
//
// 设置菜单大卡: 标题+描述在左, 超大半透图标从右缘探出;
// hover 时主题色描边, 文字与图标回色, 扫光从左侧淡入.
// 装饰统一走 ema-card-decorate primitive, 不在组件里手写伪元素.

export interface MenuIconItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title:       string;
  description: string;
  /** UnoCSS icon class, e.g. "i-solar:settings-bold-duotone". */
  icon:        string;
}

export function MenuIconItem(props: MenuIconItemProps): React.JSX.Element {
  const { title, description, icon, className, ...rest } = props;

  return (
    <button
      type="button"
      className={cn(
        'group relative w-full flex items-center overflow-hidden box-border',
        'rounded-xl p-5 text-left cursor-pointer',
        'ema-card-decorate',
        'bg-[var(--ema-surface-1)] ema-glass-weak border border-solid border-[var(--ema-border)]',
        'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
        'active:scale-[0.97]',
        'transition-ema',
        className,
      )}
      {...rest}
    >
      <div className="relative z-1 flex-1 min-w-0">
        <div className="text-lg font-semibold text-[var(--ema-text-primary)] group-hover:text-[var(--ema-primary-text)] transition-ema">
          {title}
        </div>
        <div className="text-sm text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary-text)]/80 transition-ema">
          {description}
        </div>
      </div>
      <div
        aria-hidden
        className={cn(
          icon,
          'absolute right-0 size-24 translate-y-4 opacity-40',
          'text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary)] group-hover:scale-120',
          'transition-ema',
        )}
      />
    </button>
  );
}
