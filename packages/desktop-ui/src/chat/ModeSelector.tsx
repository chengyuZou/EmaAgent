/**
 * ModeSelector — dropdown for TurnMode, with cascading Agent sub-mode flyout.
 *
 * When Agent mode is active, the Agent row shows a ▶ arrow, and a secondary
 * menu (Full / Plan / Debug) flies out to the right with a slide+fade animation.
 */
import { useState, useRef, type JSX } from 'react';
import type { TurnMode, AgentSubMode } from '@ema-agent/contracts';

interface ModeSelectorProps {
  mode:         TurnMode;
  subMode?:     AgentSubMode;
  onModeChange(mode: TurnMode, subMode?: AgentSubMode): void;
}

const MODES: Array<{ id: TurnMode; label: string; icon: string }> = [
  { id: 'chat',      label: '聊天', icon: '💬' },
  { id: 'narrative', label: '叙事', icon: '📖' },
  { id: 'agent',     label: 'Agent', icon: '🛠' },
];

const SUB_MODES: Array<{ id: AgentSubMode; label: string }> = [
  { id: 'full',  label: 'Full' },
  { id: 'plan',  label: 'Plan' },
  { id: 'debug', label: 'Debug' },
];

export function ModeSelector({ mode, subMode, onModeChange }: ModeSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [flyout, setFlyout] = useState(false);
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  const currentSub = (subMode ?? 'full') as AgentSubMode;

  // 150ms grace period so the cursor can travel from Agent row → flyout
  // without the flyout disappearing mid-flight.
  function scheduleFlyoutClose(): void {
    flyoutTimer.current = setTimeout(() => setFlyout(false), 150);
  }
  function cancelFlyoutClose(): void {
    if (flyoutTimer.current) { clearTimeout(flyoutTimer.current); flyoutTimer.current = null; }
  }

  // Vertical offset so the flyout aligns with the Agent row (each row ~34px)
  const agentRowIndex = MODES.findIndex((m) => m.id === 'agent');

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-50 bg-gray-800 border border-gray-700 rounded-xl py-1 shadow-xl min-w-32">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={
                  'group relative w-full flex items-center text-left px-3 py-1.5 text-sm transition-colors' +
                  (mode === m.id
                    ? ' text-pink-300 bg-pink-400/10'
                    : ' text-gray-300 hover:bg-gray-700')
                }
                onClick={() => {
                  onModeChange(m.id, m.id === 'agent' ? currentSub : undefined);
                  if (m.id !== 'agent') setOpen(false);
                }}
                onMouseEnter={() => { if (m.id === 'agent') { cancelFlyoutClose(); setFlyout(true); } }}
                onMouseLeave={() => { if (m.id === 'agent') scheduleFlyoutClose(); }}
              >
                <span className="mr-2">{m.icon}</span>
                <span className="flex-1">{m.label}</span>
                {mode === m.id && <span className="text-pink-400">✓</span>}
                {m.id === 'agent' && (
                  <span className="ml-1 text-[10px] text-gray-500 group-hover:text-gray-300 transition-colors">
                    ▶
                  </span>
                )}
              </button>
            ))}

            {/* Agent sub-mode flyout — slides in from the right */}
            <div
              className={
                'absolute left-full top-0 ml-1 z-50 bg-gray-800 border border-gray-700 rounded-xl py-1 shadow-xl min-w-24' +
                ' transition-all duration-150 ease-out' +
                (flyout ? ' opacity-100 translate-x-0' : ' opacity-0 -translate-x-1 pointer-events-none')
              }
              style={{ marginTop: agentRowIndex * 34 + 4 }}
              onMouseEnter={() => { cancelFlyoutClose(); setFlyout(true); }}
              onMouseLeave={() => scheduleFlyoutClose()}
            >
              {SUB_MODES.map((sm) => (
                <button
                  key={sm.id}
                  className={
                    'w-full flex items-center text-left px-3 py-1.5 text-xs transition-colors' +
                    (currentSub === sm.id
                      ? ' text-pink-300 bg-pink-400/10'
                      : ' text-gray-400 hover:bg-gray-700 hover:text-gray-300')
                  }
                  onClick={() => {
                    onModeChange('agent', sm.id);
                    setOpen(false);
                    setFlyout(false);
                  }}
                >
                  <span className="flex-1">{sm.label}</span>
                  {currentSub === sm.id && <span className="text-pink-400">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
