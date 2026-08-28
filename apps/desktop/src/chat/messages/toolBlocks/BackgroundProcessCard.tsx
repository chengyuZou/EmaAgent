// 已转交后台的 Bash 入口卡:块当场终结,卡片只给面板入口,不持续刷新。
import type { JSX } from 'react';

import { useCurrentSession } from '../../state/currentSession.js';
import { useDockTabs } from '../../frame/dockTabs.js';

export function BackgroundProcessCard({
  command, status,
}: {
  command: string;
  status: 'queued' | 'running' | string;
}): JSX.Element {
  const sessionId = useCurrentSession((s) => s.viewedSessionId);
  const openTab = useDockTabs((s) => s.openTab);

  return (
    <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 pr-6 text-[11px] bg-[var(--ema-surface-1)] border-[var(--ema-border)]">
      <span className="i-lucide:square-terminal shrink-0 text-sm text-[var(--ema-primary)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[var(--ema-text-secondary)]" title={command}>
        已转到后台{status === 'queued' ? '排队' : '运行'}
      </span>
      <button
        className="shrink-0 text-[var(--ema-primary)] hover:text-[var(--ema-primary-hover)] transition-colors"
        onClick={() => {
          if (sessionId) {
            openTab(sessionId, { id: 'backgroundProcesses', kind: 'backgroundProcesses' });
          }
        }}
      >
        查看后台进程
      </button>
    </div>
  );
}