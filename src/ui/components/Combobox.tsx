// 提供支持筛选、键盘导航和读屏状态同步的可搜索单选组件。
import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { cn } from '../utils/cn.js';
import { Popover } from './Popover.js';

// ── Combobox ────────────────────────────────────────────────────────────────
//
// Searchable select built on the existing Popover component. Key behaviours:
//   - Type to filter the list
//   - ↓↑ arrow keys cycle through ENABLED options only (wrap-around), Enter
//     selects the highlighted option, Esc closes
//   - Highlight never rests on a disabled option; filter change resets it to
//     the first enabled option
//   - Click outside closes
//   - Selection callback fires with the chosen option value
//
// Uses Popover's trigger/children pattern — the input IS the trigger.
// Sufficient for V1 use cases: model picker (~10 items), session switcher (~50
// items). For >500 filtered items, a virtualised alternative would be warranted
// (V2).

export interface ComboboxOption {
  value:    string;
  label:    string;
  hint?:    string;
  disabled?: boolean;
}

// ── 键盘导航决策(纯函数, 供组件与测试共用; F-037) ────────────────────────────

/** 第一个未禁用选项的下标; 没有可用项返回 -1。 */
export function firstEnabledIndex(options: ComboboxOption[]): number {
  return options.findIndex((o) => !o.disabled);
}

/** 最后一个未禁用选项的下标; 没有可用项返回 -1。 */
export function lastEnabledIndex(options: ComboboxOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]!.disabled) return index;
  }
  return -1;
}

/** 从 fromIdx 沿 dir(1|-1) 环形移动到下一个未禁用选项; 没有可用项返回 -1。 */
export function nextEnabledIndex(options: ComboboxOption[], fromIdx: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  let i = fromIdx;
  for (let step = 0; step < n; step++) {
    i = (((i + dir) % n) + n) % n;
    if (!options[i]!.disabled) return i;
  }
  return -1;
}

/** 高亮下标的唯一口径: 越界或指向 disabled 时回退第一个可用项; 全禁用返回 -1。 */
export function deriveActiveIndex(options: ComboboxOption[], activeIdx: number): number {
  const opt = options[activeIdx];
  return opt !== undefined && !opt.disabled ? activeIdx : firstEnabledIndex(options);
}

export interface ComboboxProps {
  options:      ComboboxOption[];
  value?:       string;
  onChange:     (value: string) => void;
  placeholder?: string;
  disabled?:    boolean;
  filter?:      (query: string, option: ComboboxOption) => boolean;
  width?:       number;
  className?:   string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = '搜索…',
  disabled = false,
  filter: customFilter,
  width = 280,
  className,
}: ComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(() => firstEnabledIndex(options));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLUListElement>(null);

  const match = customFilter ?? (
    (q: string, o: ComboboxOption): boolean =>
      o.label.toLowerCase().includes(q.toLowerCase())
  );

  const filtered = query ? options.filter((o) => match(query, o)) : options;
  const safeIdx = deriveActiveIndex(filtered, activeIdx);
  const selectedLabel = options.find((o) => o.value === value)?.label ?? '';

  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const optionId = (option: ComboboxOption): string =>
    `${uid}-option-${encodeURIComponent(option.value)}`;

  const initialActiveIndex = useCallback((): number => {
    const selectedIndex = filtered.findIndex((option) => option.value === value && !option.disabled);
    return selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(filtered);
  }, [filtered, value]);

  const openList = useCallback(() => {
    setOpen(true);
    setActiveIdx(initialActiveIndex());
  }, [initialActiveIndex]);

  const reset = useCallback(() => {
    setQuery('');
    setActiveIdx(firstEnabledIndex(options));
    setOpen(false);
  }, [options]);

  const select = useCallback((opt: ComboboxOption) => {
    onChange(opt.value);
    reset();
    inputRef.current?.blur();
  }, [onChange, reset]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIdx(firstEnabledIndex(filtered));
          return;
        }
        setActiveIdx(nextEnabledIndex(filtered, safeIdx, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIdx(lastEnabledIndex(filtered));
          return;
        }
        setActiveIdx(nextEnabledIndex(filtered, safeIdx, -1));
        break;
      case 'Enter': {
        e.preventDefault();
        if (!open) {
          openList();
          return;
        }
        const candidate = filtered[safeIdx];
        if (candidate && !candidate.disabled) select(candidate);
        break;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          reset();
        }
        break;
    }
  };

  useEffect(() => {
    if (listRef.current) {
      const item = safeIdx >= 0
        ? listRef.current.children[safeIdx] as HTMLLIElement | undefined
        : undefined;
      item?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, safeIdx]);

  const trigger = (
    <input
      ref={inputRef}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-autocomplete="list"
      aria-controls={listboxId}
      aria-activedescendant={
        open && safeIdx >= 0 ? optionId(filtered[safeIdx]!) : undefined
      }
      disabled={disabled}
      value={open ? query : selectedLabel}
      placeholder={open ? '输入筛选…' : placeholder}
      onFocus={openList}
      onChange={(e) => {
        const nextQuery = e.target.value;
        const nextFiltered = nextQuery
          ? options.filter((option) => match(nextQuery, option))
          : options;
        setQuery(nextQuery);
        setOpen(true);
        setActiveIdx(firstEnabledIndex(nextFiltered));
      }}
      onKeyDown={onKeyDown}
      onClick={openList}
      className={cn(
        'w-full rounded-md border px-3 py-2 text-sm outline-none transition-ema',
        'bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)]',
        'border-[var(--ema-border)] hover:border-[var(--ema-border-hover)]',
        'focus:border-[var(--ema-primary)] focus:ring-2 focus:ring-[var(--ema-primary)]/40',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) openList();
        else reset();
      }}
      trigger={trigger}
      side="bottom"
      align="start"
      sideOffset={4}
      style={{ width }}
      widthClass=""
    >
      <div className="max-h-64 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-[var(--ema-text-tertiary)]">无匹配结果</p>
        ) : (
          <ul id={listboxId} ref={listRef} role="listbox" className="flex flex-col gap-0.5">
            {filtered.map((opt, i) => (
              <li
                key={opt.value}
                id={optionId(opt)}
                role="option"
                aria-selected={opt.value === value}
                aria-disabled={opt.disabled || undefined}
                className={cn(
                  'flex flex-col rounded-sm px-3 py-1.5 text-sm cursor-pointer transition-ema',
                  i === safeIdx
                    ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)]'
                    : opt.value === value
                      ? 'bg-[var(--ema-surface-3)] text-[var(--ema-primary-text)]'
                      : 'text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]',
                  opt.disabled && 'cursor-not-allowed opacity-40',
                )}
                onClick={() => !opt.disabled && select(opt)}
                onMouseEnter={() => {
                  if (!opt.disabled) setActiveIdx(i);
                }}
              >
                <span className="truncate">{opt.label}</span>
                {opt.hint && <span className="text-xs text-[var(--ema-text-tertiary)] truncate">{opt.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}
