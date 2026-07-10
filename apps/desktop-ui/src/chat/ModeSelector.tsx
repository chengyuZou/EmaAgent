/**
 * ModeSelector — dropdown for TurnMode.
 */
import { useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { TurnMode } from '@ema-agent/contracts';

interface ModeSelectorProps {
  mode:         TurnMode;
  onModeChange(mode: TurnMode): void;
}

const MODES: Array<{ id: TurnMode; label: string; icon: string }> = [
  { id: 'chat',      label: '聊天', icon: 'i-lucide:message-circle' },
  { id: 'narrative', label: '叙事', icon: 'i-lucide:book-open' },
  { id: 'agent',     label: 'Agent', icon: 'i-lucide:bot' },
];

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs
                   text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)]
                   hover:bg-[var(--ema-surface-2)]
                   transition-colors duration-[var(--ema-duration-base)]"
        onClick={() => setOpen(!open)}
      >
        <span className={current.icon + ' text-sm'} aria-hidden />
        <span>{current.label}</span>
        <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="ema-slide-up absolute bottom-full left-0 mb-1 z-50
                       bg-[var(--ema-surface-4)] border border-[var(--ema-border)]
                       rounded-xl p-1 shadow-[var(--ema-shadow-3)] min-w-32"
          >
            {MODES.map((m) => (
              <Button
                key={m.id}
                variant="ghost"
                className={
                  'w-full flex items-center text-left px-3 py-1.5 text-sm rounded-lg ' +
                  `transition-colors duration-[var(--ema-duration-base)] ` +
                  (mode === m.id
                    ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                    : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-3)] hover:text-[var(--ema-text-primary)]')
                }
                onClick={() => {
                  onModeChange(m.id);
                  setOpen(false);
                }}
              >
                <span className={`${m.icon} text-sm mr-2`} aria-hidden />
                <span className="flex-1">{m.label}</span>
                {mode === m.id && (
                  <span className="i-lucide:check text-[var(--ema-primary)] text-xs" aria-hidden />
                )}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
