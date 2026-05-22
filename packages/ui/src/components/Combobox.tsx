import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '../utils/cn.js';
import { Popover } from './Popover.js';

// ── Combobox ────────────────────────────────────────────────────────────────
//
// Searchable select built on the existing Popover component. Key behaviours:
//   - Type to filter the list
//   - ↓↑ arrow keys navigate, Enter selects, Esc closes
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
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLUListElement>(null);

  const match = customFilter ?? (
    (q: string, o: ComboboxOption): boolean =>
      o.label.toLowerCase().includes(q.toLowerCase())
  );

  const filtered = query ? options.filter((o) => match(query, o)) : options;
  const safeIdx = Math.min(activeIdx, Math.max(0, filtered.length - 1));
  const selectedLabel = options.find((o) => o.value === value)?.label ?? '';

  const reset = useCallback(() => {
    setQuery('');
    setActiveIdx(0);
    setOpen(false);
  }, []);

  const select = useCallback((opt: ComboboxOption) => {
    onChange(opt.value);
    reset();
    inputRef.current?.blur();
  }, [onChange, reset]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (!open) { setOpen(true); return; } setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); break;
      case 'ArrowUp':   e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); break;
      case 'Enter':     e.preventDefault(); if (!open) { setOpen(true); return; } { const c = filtered[safeIdx]; if (c && !c.disabled) select(c); } break;
      case 'Escape':    reset(); break;
    }
  };

  useEffect(() => {
    if (listRef.current) {
      const item = listRef.current.children[safeIdx] as HTMLLIElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [safeIdx]);

  const trigger = (
    <input
      ref={inputRef}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-autocomplete="list"
      disabled={disabled}
      value={open ? query : selectedLabel}
      placeholder={open ? '输入筛选…' : placeholder}
      onFocus={() => setOpen(true)}
      onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIdx(0); }}
      onKeyDown={onKeyDown}
      onClick={() => setOpen(true)}
      className={cn(
        'w-full rounded-md border px-3 py-2 text-sm outline-none transition-ema',
        'bg-neutral-900/60 text-neutral-100 placeholder:text-neutral-500',
        'border-neutral-700/50 hover:border-neutral-600',
        'focus:border-primary-300 focus:ring-2 focus:ring-primary-300/40',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}
      trigger={trigger}
      side="bottom"
      align="start"
      sideOffset={4}
      widthClass={`w-[${width}px]`}
    >
      <div className="max-h-64 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-neutral-500">无匹配结果</p>
        ) : (
          <ul ref={listRef} role="listbox" className="flex flex-col gap-0.5">
            {filtered.map((opt, i) => (
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                aria-disabled={opt.disabled || undefined}
                className={cn(
                  'flex flex-col rounded-sm px-3 py-1.5 text-sm cursor-pointer transition-ema',
                  i === safeIdx
                    ? 'bg-primary-500/20 text-primary-100'
                    : opt.value === value
                      ? 'bg-primary-500/10 text-primary-100'
                      : 'text-neutral-200 hover:bg-neutral-800',
                  opt.disabled && 'cursor-not-allowed opacity-40',
                )}
                onClick={() => !opt.disabled && select(opt)}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span className="truncate">{opt.label}</span>
                {opt.hint && <span className="text-xs text-neutral-500 truncate">{opt.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}
