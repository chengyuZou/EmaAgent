// Dock 空白或 + 触发时的工作区启动器：居中浮出菜单，只列有真实能力的入口。
import { useEffect, type JSX } from 'react';

import { Button } from '@ema-agent/ui';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { workspaceTabIcon } from './WorkspaceTabBar.js';
import type { WorkspaceDockId, WorkspaceTab } from '../../stores/workspaceTypes.js';

// 只放当前有真实能力的资源；Terminal/Browser 有运行时之前不进入此列表。
const LAUNCHER_TABS: readonly WorkspaceTab[] = [
  { id: 'review', kind: 'review' },
  { id: 'files', kind: 'files' },
  { id: 'sources', kind: 'sources' },
  { id: 'agentRuns', kind: 'agentRuns' },
];

const LAUNCHER_LABELS: Record<string, string> = {
  review: '审阅',
  files: '文件',
  sources: '来源',
  agentRuns: '子智能体',
};

export interface WorkspaceLauncherProps {
  sessionId: string;
  dock: WorkspaceDockId;
  /** overlay 模式（已有标签时由 + 触发）可关闭；嵌入模式（空 Dock）常显。 */
  onClose?: () => void;
}

export function WorkspaceLauncher({
  sessionId, dock, onClose,
}: WorkspaceLauncherProps): JSX.Element {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const overlay = onClose !== undefined;

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
