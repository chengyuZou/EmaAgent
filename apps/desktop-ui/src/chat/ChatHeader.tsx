// 聊天列顶栏：会话标题与置顶摘要、底部面板、右侧栏三个工作区入口；
// RightDock 全宽时替换为恢复面板宽度单按钮。
import { useState, type JSX } from 'react';

import { IconButton, Popover } from '@ema-agent/ui';
import { useAgentRunStore } from '../stores/agentRunStore.js';
import { isRightFullWidth, useWorkspaceStore } from '../stores/workspaceStore.js';
import { PinnedSessionSummary } from './summary/PinnedSessionSummary.js';

export interface ChatHeaderProps {
  sessionId: string | null;
  title: string;
  isFork: boolean;
}

export function ChatHeader({ sessionId, title, isFork }: ChatHeaderProps): JSX.Element {
  const [summaryOpen, setSummaryOpen] = useState(false);

  const layout = useWorkspaceStore((s) =>
    sessionId ? s.layouts[sessionId as string] : undefined);
  const setDockOpen = useWorkspaceStore((s) => s.setDockOpen);
  const setFullWidth = useWorkspaceStore((s) => s.setFullWidth);
  const fullWidth = useWorkspaceStore((s) => isRightFullWidth(s, sessionId));
  const rightOpen = layout?.rightOpen ?? false;
  const bottomOpen = layout?.bottomOpen ?? false;

  // 子智能体运行计数：摘要按钮的角标，详情在浮层内。
  const runningAgentRunCount = useAgentRunStore((s) => {
    if (!sessionId) return 0;
    return [...s.runs.values()].filter(
      (run) => run.sessionId === (sessionId as string) && run.status === 'running',
    ).length;
  });

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b shrink-0 border-[var(--ema-border)]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate text-[var(--ema-text-secondary)]">
          {title}
        </span>
        {isFork && (
          <span className="text-xs text-[var(--ema-text-tertiary)]">· 会话副本</span>
        )}
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        {sessionId && (
          fullWidth ? (
            // 全宽时三入口收敛为恢复面板宽度（§3.5）。
            <button
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors text-[var(--ema-primary)] hover:bg-[var(--ema-primary-muted)]"
              onClick={() => setFullWidth(sessionId, false)}
            >
              <span className="i-lucide:minimize-2 text-sm" aria-hidden />
              恢复面板宽度
            </button>
          ) : (
          <>
            <Popover
              open={summaryOpen}
              onOpenChange={setSummaryOpen}
              side="bottom"
              align="end"
              widthClass="w-72"
              trigger={
                <span className="relative">
                  <IconButton
                    size="md"
                    label="置顶摘要"
                    icon="i-lucide:panel-top"
                    toggled={summaryOpen}
                  />
                  {runningAgentRunCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full text-[9px] font-bold px-0.5 pointer-events-none bg-[var(--ema-primary)] text-[var(--ema-text-primary)]">
                      {runningAgentRunCount}
                    </span>
                  )}
                </span>
              }
            >
              <PinnedSessionSummary sessionId={sessionId} />
            </Popover>

            <IconButton
              size="md"
              label={bottomOpen ? '折叠底部面板' : '展开底部面板'}
              icon="i-lucide:panel-bottom"
              toggled={bottomOpen}
              onClick={() => setDockOpen(sessionId, 'bottom', !bottomOpen)}
            />
            <IconButton
              size="md"
              label={rightOpen ? '折叠右侧栏' : '展开右侧栏'}
              icon="i-lucide:panel-right"
              toggled={rightOpen}
              onClick={() => setDockOpen(sessionId, 'right', !rightOpen)}
            />
          </>
          )
        )}
      </div>
    </div>
  );
}
