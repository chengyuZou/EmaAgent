/**
 * ModeSelector — dropdown for TurnMode.
 */
import { useState, type JSX } from 'react';
import type { TurnMode } from '@ema-agent/contracts';

interface ModeSelectorProps {
  mode:         TurnMode;
  onModeChange(mode: TurnMode): void;
}

const MODES: Array<{ id: TurnMode; label: string; icon: string }> = [
  { id: 'chat',      label: '聊天', icon: '💬' },
  { id: 'narrative', label: '叙事', icon: '📖' },
  { id: 'agent',     label: 'Agent', icon: '🛠' },
];

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <span className="text-[10px]">▴</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-50 bg-gray-800 border border-gray-700 rounded-xl py-1 shadow-xl min-w-32">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={
                  'w-full flex items-center text-left px-3 py-1.5 text-sm transition-colors' +
                  (mode === m.id
                    ? ' text-pink-300 bg-pink-400/10'
                    : ' text-gray-300 hover:bg-gray-700')
                }
                onClick={() => {
                  onModeChange(m.id);
                  setOpen(false);
                }}
              >
                <span className="mr-2">{m.icon}</span>
                <span className="flex-1">{m.label}</span>
                {mode === m.id && <span className="text-pink-400">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
