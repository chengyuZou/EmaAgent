// SearchField — 一体式搜索杆:外层 pill 统一承担边框与焦点环,input 自身无框无背景。
// 传 onSubmit 才内嵌搜索按钮(固定宽度不参与压缩,避免文字被挤成两行);
// 不传则为纯即时筛选。Enter 提交;有内容才出现 × 清除。
import { forwardRef, type JSX } from 'react';
import { cn } from '../utils/cn.js';

export interface SearchFieldProps {
  value:            string;
  onChange:         (value: string) => void;
  /** 传入即显示内嵌提交按钮;Enter 总是触发它。 */
  onSubmit?:        () => void;
  /** 提交按钮内的 spinner 与禁用态。 */
  loading?:         boolean;
  disabled?:        boolean;
  placeholder?:     string;
  className?:       string;
  'aria-label'?:    string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(props, ref) {
    const {
      value, onChange, onSubmit,
      loading = false, disabled = false,
      placeholder, className,
    } = props;

    return (
      <form
        role="search"
        aria-label={props['aria-label']}
        className={cn(
          'group flex h-11 w-full items-center gap-2 rounded-xl border border-solid',
          'border-[var(--ema-control-border)] bg-[var(--ema-control-bg)] pl-3 pr-1.5',
          'shadow-[var(--ema-control-shadow)]',
          'transition-[background-color,border-color,box-shadow] duration-[var(--ema-duration-fast)]',
          'hover:bg-[var(--ema-control-bg-hover)] hover:border-[var(--ema-control-border-hover)]',
          'focus-within:bg-[var(--ema-control-bg-focus)] focus-within:border-[var(--ema-control-border-focus)] focus-within:shadow-[var(--ema-control-shadow-focus)]',
          disabled && 'opacity-60',
          className,
        )}
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !loading) onSubmit?.();
        }}
      >
        <span
          className="i-lucide:search shrink-0 text-base text-[var(--ema-text-tertiary)]
            transition-colors duration-[var(--ema-duration-fast)]
            group-focus-within:text-[var(--ema-primary)]"
          aria-hidden
        />
        <input
          ref={ref}
          type="search"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 font-mono text-sm
            text-[var(--ema-text-primary)] caret-[var(--ema-primary)] outline-none
            placeholder:text-[var(--ema-text-tertiary)]
            [&::-webkit-search-cancel-button]:appearance-none
            [&::-webkit-search-decoration]:appearance-none"
          onChange={(event) => onChange(event.target.value)}
        />
        {value.length > 0 && (
          <button
            type="button"
            aria-label="清除搜索"
            title="清除搜索"
            disabled={disabled}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md
              text-[var(--ema-text-tertiary)] transition-colors
              hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]
              focus-visible:outline-2 focus-visible:outline-[var(--ema-primary)]"
            onClick={() => onChange('')}
          >
            <span className="i-lucide:x text-sm" aria-hidden />
          </button>
        )}
        {onSubmit && (
          <button
            type="submit"
            aria-busy={loading || undefined}
            disabled={disabled || loading}
            className="flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap
              rounded-lg border-0 bg-[var(--ema-primary-muted)] px-3 text-sm font-semibold
              text-[var(--ema-primary)] transition-colors
              hover:bg-[var(--ema-primary)] hover:text-[var(--ema-primary-text)]
              active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ema-primary)]"
          >
            {loading && <span className="i-svg-spinners:ring-resize text-xs" aria-hidden />}
            搜索
          </button>
        )}
      </form>
    );
  },
);
