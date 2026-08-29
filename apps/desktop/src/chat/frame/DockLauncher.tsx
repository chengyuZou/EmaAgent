// Dock 空白或 + 触发时的工作区启动器：居中浮出菜单，只列有真实能力的入口。
import { useEffect, useState, type JSX } from 'react';
import { nanoid } from 'nanoid';

import { Button } from '@ema-agent/ui';
import { useSessionStore } from '../../stores/session.js';
import { browserTab, terminalTab, useDockTabs } from './dockTabs.js';
import { workspaceTabIcon } from './DockTabBar.js';
import type { DockSide, DockTab } from './dockTabs.js';
import { startTerminal } from './tabs/terminal/terminalSessions.js';

// 固定标签直接列在这里；终端和浏览器需要各自生成独立身份，入口在下方。
const LAUNCHER_TABS: readonly DockTab[] = [
  { id: 'review', kind: 'review' },
  { id: 'files', kind: 'files' },
];

const LAUNCHER_LABELS: Record<string, string> = {
  review: '审阅',
  files: '文件',
};

export interface DockLauncherProps {
  sessionId: string;
  dock: DockSide;
  /** overlay 模式（已有标签时由 + 触发）可关闭；嵌入模式（空 Dock）常显。 */
  onClose?: () => void;
}

export function DockLauncher({
  sessionId, dock, onClose,
}: DockLauncherProps): JSX.Element {
  const openTab = useDockTabs((s) => s.openTab);
  const workspaceRoot = useSessionStore((s) => s.sessions.byId.get(sessionId)?.workspaceRoot ?? null);
  const overlay = onClose !== undefined;
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlay, onClose]);

  const menu = (
    <div className="flex flex-col gap-0.5 w-44 rounded-xl border p-1.5 shadow-[var(--ema-shadow-3)] bg-[var(--ema-surface-4)] border-[var(--ema-border-hover)]">
      {LAUNCHER_TABS.map((tab) => (
        <Button
          key={tab.id}
          variant="ghost"
          className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-normal rounded-lg text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-3)]"
          onClick={() => {
            openTab(sessionId, tab, { dock });
            onClose?.();
          }}
        >
          <span className={`${workspaceTabIcon(tab)} text-base shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
          {LAUNCHER_LABELS[tab.id]}
        </Button>
      ))}
      <Button
        variant="ghost"
        disabled={openingTerminal}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-normal rounded-lg text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-3)]"
        onClick={() => {
          const terminalId = nanoid();
          setOpeningTerminal(true);
          setError(null);
          void startTerminal({
            terminalId,
            sessionId,
            ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
          }).then(() => {
            openTab(sessionId, terminalTab(terminalId), { dock });
            onClose?.();
          }).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : '终端打开失败');
          }).finally(() => setOpeningTerminal(false));
        }}
      >
        <span className="i-lucide:terminal text-base shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
        {openingTerminal ? '正在打开终端…' : '终端'}
      </Button>
      <Button
        variant="ghost"
        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-normal rounded-lg text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-3)]"
        onClick={() => {
          const browserId = nanoid();
          openTab(sessionId, browserTab(browserId, 'https://www.bing.com/'), { dock });
          onClose?.();
        }}
      >
        <span className="i-lucide:globe text-base shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
        浏览器
      </Button>
      {error && <div className="px-3 py-1 text-[11px] text-[var(--ema-danger)]">{error}</div>}
    </div>
  );

  if (!overlay) {
    return (
      <div className="flex-1 flex items-center justify-center ema-fade-in">
        {menu}
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center ema-fade-in bg-[var(--ema-mask)]"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>{menu}</div>
    </div>
  );
}
