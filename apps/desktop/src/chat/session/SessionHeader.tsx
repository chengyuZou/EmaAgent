import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { IconButton, Popover } from '@ema-agent/ui';
import { sessionGitApi, type SessionGitSummary } from '../../api/git.js';
import { useAgentRunStore } from '../../stores/agentRun.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useSessionStore } from '../../stores/session.js';
import { SessionCwdDialog } from './SessionCwdDialog.js';
import {
  isSessionSidePanelFullWidth,
  sessionSourceTab,
  useSessionSidePanel,
} from '../state/chatWorkspace.js';

const SOURCE_PREVIEW_COUNT = 3;

export function SessionHeader({
  sessionId,
  title,
  isFork,
}: {
  sessionId: string;
  title: string;
  isFork: boolean;
}): JSX.Element {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [cwdOpen, setCwdOpen] = useState(false);
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd);
  const layout = useSessionSidePanel((state) => state.layouts[sessionId]);
  const setOpen = useSessionSidePanel((state) => state.setOpen);
  const setFullWidth = useSessionSidePanel((state) => state.setFullWidth);
  const fullWidth = useSessionSidePanel((state) => (
    isSessionSidePanelFullWidth(state, sessionId)
  ));
  const runningAgentRunCount = useAgentRunStore(state => {
    const ids = new Set<string>();
    for (const run of state.runs.values()) {
      if (run.sessionId === sessionId && run.status === 'running') ids.add(run.id);
    }
    for (const [id, run] of state.live) {
      if (run.sessionId === sessionId) ids.add(id);
    }
    return ids.size;
  });

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-[var(--ema-border)] px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-[var(--ema-text-secondary)]">{title}</span>
        {cwd && (
          <button
            type="button"
            className="flex max-w-64 min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--ema-text-tertiary)] transition-colors hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
            title={`执行目录: ${cwd} · 点击修改`}
            onClick={() => setCwdOpen(true)}
          >
            <span className="i-lucide:folder-open shrink-0 text-sm" aria-hidden />
            <span className="truncate">{cwd}</span>
          </button>
        )}
        {isFork && <span className="text-xs text-[var(--ema-text-tertiary)]">· 会话副本</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {fullWidth ? (
          <button
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--ema-primary)] hover:bg-[var(--ema-primary-muted)]"
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
              trigger={(
                <span className="relative">
                  <IconButton
                    size="md"
                    label="置顶摘要"
                    icon="i-lucide:panel-top"
                    toggled={summaryOpen}
                  />
                  {runningAgentRunCount > 0 && (
                    <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--ema-primary)] px-0.5 text-[9px] font-bold text-[var(--ema-text-primary)]">
                      {runningAgentRunCount}
                    </span>
                  )}
                </span>
              )}
            >
              <SessionSummary sessionId={sessionId} />
            </Popover>
            <IconButton
              size="md"
              label={layout?.open ? '折叠右侧栏' : '展开右侧栏'}
              icon="i-lucide:panel-right"
              toggled={layout?.open ?? false}
              onClick={() => setOpen(sessionId, !(layout?.open ?? false))}
            />
          </>
        )}
      </div>
      <SessionCwdDialog sessionId={sessionId} open={cwdOpen} onOpenChange={setCwdOpen} />
    </header>
  );
}

function SessionSummary({ sessionId }: { sessionId: string }): JSX.Element {
  const openTab = useSessionSidePanel((state) => state.openTab);
  const cwd = useSessionStore((state) => (
    state.sessions.byId.get(sessionId)?.cwd ?? null
  ));
  const [git, setGit] = useState<SessionGitSummary | null>(null);
  const activity = useAgentRunStore(useShallow(state => {
    const running = new Set<string>();
    let ended = 0;
    for (const run of state.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.status === 'running') running.add(run.id); else ended += 1;
    }
    for (const [id, run] of state.live) {
      if (run.sessionId === sessionId) running.add(id);
    }
    return { running: running.size, ended };
  }));
  const sources = useSessionAttachmentStore(state => state.bySession.get(sessionId));

  useEffect(() => {
    if (!cwd) {
      setGit(null);
      return;
    }
    let mounted = true;
    void sessionGitApi.summary(sessionId)
      .then((value) => {
        if (mounted) setGit(value);
      })
      .catch(() => {
        if (mounted) setGit(null);
      });
    return () => {
      mounted = false;
    };
  }, [sessionId, cwd]);
  useEffect(() => { void useAgentRunStore.getState().loadForSession(sessionId); }, [sessionId]);
  useEffect(() => { void useSessionAttachmentStore.getState().loadForSession(sessionId); }, [sessionId]);

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      {cwd && (
        <section>
          <SectionTitle>环境信息</SectionTitle>
          <ReadOnlyRow icon="i-lucide:file-diff" label="变更">
            <GitChanges git={git} />
          </ReadOnlyRow>
          <ReadOnlyRow icon="i-lucide:monitor" label="本地">
            <span className="truncate text-[var(--ema-text-tertiary)]" title={cwd}>
              {cwd}
            </span>
          </ReadOnlyRow>
          <ReadOnlyRow icon="i-lucide:git-branch" label="分支">
            <span className="truncate text-[var(--ema-text-tertiary)]">
              {git?.capability === 'ok' ? git.branch ?? '未命名分支' : '不可用'}
            </span>
          </ReadOnlyRow>
        </section>
      )}
      <section>
        <SectionTitle>子智能体</SectionTitle>
        <button
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--ema-surface-2)]"
          onClick={() => openTab(sessionId, { id: 'subagents', kind: 'subagents' })}
        >
          <span className="i-lucide:bot text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
          {activity.running > 0
            ? <span className="text-[var(--ema-primary)]">{activity.running} 个运行中</span>
            : <span className="text-[var(--ema-text-tertiary)]">没有运行中的子智能体</span>}
          {activity.ended > 0 && (
            <span className="ml-auto text-[var(--ema-text-tertiary)]">
              {activity.ended} 已完成
            </span>
          )}
        </button>
      </section>
      <section>
        <SectionTitle>来源</SectionTitle>
        {sources === undefined ? (
          <p className="px-1 text-[var(--ema-text-tertiary)]">加载中…</p>
        ) : sources.length === 0 ? (
          <p className="px-1 text-[var(--ema-text-tertiary)]">暂无来源</p>
        ) : (
          <>
            {sources.slice(0, SOURCE_PREVIEW_COUNT).map((source) => (
              <button
                key={source.path}
                className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--ema-surface-2)]"
                onClick={() => openTab(sessionId, sessionSourceTab(source.path))}
              >
                <span
                  className={source.kind === 'image'
                    ? 'i-lucide:image'
                    : 'i-lucide:file-text'}
                  aria-hidden
                />
                <span className="truncate text-[var(--ema-text-secondary)]">
                  {source.kind === 'image'
                    ? source.name ?? '剪贴板图片'
                    : '粘贴文本'}
                </span>
              </button>
            ))}
            <button
              className="mt-1 px-1 text-[var(--ema-primary)] hover:underline"
              onClick={() => openTab(sessionId, { id: 'sources', kind: 'sources' })}
            >
              查看全部
              {sources.length > SOURCE_PREVIEW_COUNT ? ` (${sources.length})` : ''}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-1 pb-1 text-[11px] font-medium text-[var(--ema-text-tertiary)]">
      {children}
    </div>
  );
}

function ReadOnlyRow({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-[var(--ema-text-secondary)]">
      <span className={`${icon} text-sm text-[var(--ema-text-tertiary)]`} aria-hidden />
      <span>{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
function GitChanges({ git }: { git: SessionGitSummary | null }): JSX.Element {
  if (!git || git.capability !== 'ok') {
    return <span className="text-[var(--ema-text-tertiary)]">不可用</span>;
  }
  const files = git.unstaged.filesChanged + git.staged.filesChanged;
  const insertions = git.unstaged.insertions + git.staged.insertions;
  const deletions = git.unstaged.deletions + git.staged.deletions;
  if (files === 0 && git.untrackedCount === 0) {
    return <span className="text-[var(--ema-text-tertiary)]">无变更</span>;
  }
  return (
    <span className="text-[var(--ema-text-tertiary)]">
      {files} 个文件{' '}
      <span className="text-[var(--ema-success)]">+{insertions}</span>{' '}
      <span className="text-[var(--ema-danger)]">-{deletions}</span>
      {git.untrackedCount > 0 ? ` · ${git.untrackedCount} 未跟踪` : ''}
    </span>
  );
}
