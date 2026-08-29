// 展示一个既有的 xterm 会话，并把 Dock 尺寸变化同步给 PTY。
import { useEffect, useRef, useState, type JSX } from 'react';
import '@xterm/xterm/css/xterm.css';

import {
  attachTerminal,
  fitTerminal,
  subscribeTerminal,
  terminalState,
} from './terminalSessions.js';

export function TerminalPanel({ terminalId }: { terminalId: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(() => terminalState(terminalId));

  useEffect(() => subscribeTerminal(terminalId, () => setState(terminalState(terminalId))), [terminalId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    attachTerminal(terminalId, host);
    const observer = new ResizeObserver(() => fitTerminal(terminalId));
    observer.observe(host);
    return () => observer.disconnect();
  }, [terminalId]);

  return (
    <div className="relative flex-1 min-h-0 bg-[#151515]">
      <div ref={hostRef} className="absolute inset-0 p-1.5" />
      {state.status === 'exited' && (
        <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-[11px] border-t bg-[var(--ema-surface-3)] border-[var(--ema-border)] text-[var(--ema-text-tertiary)]">
          终端已退出{state.exitCode === null ? '' : `，退出码 ${state.exitCode}`}
        </div>
      )}
    </div>
  );
}

