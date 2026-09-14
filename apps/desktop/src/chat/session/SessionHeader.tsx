import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Dialog, IconButton, Input, Popover } from '@ema-agent/ui';
import { sessionGitApi, type SessionGitSummary } from '../../api/git.js';
import { showToast } from '../../lib/toast.js';
import { useAgentRunStore } from '../../stores/agentRun.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useSessionStore } from '../../stores/session.js';
import { SessionCwdDialog } from './SessionCwdDialog.js';
import {
  sessionSourceTab,
  useSessionSidePanel,
} from '../state/chatWorkspace.js';

const SOURCE_PREVIEW_COUNT = 3;

export function SessionHeader({ sessionId }: { sessionId: string }): JSX.Element {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [cwdOpen, setCwdOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleSaving, setTitleSaving] = useState(false);
  const session = useSessionStore(state => state.sessions.byId.get(sessionId));
  const title = session?.title ?? '加载中…';
  const cwd = session?.cwd;
  const layout = useSessionSidePanel((state) => state.layouts[sessionId]);
  const setSidePanelOpen = useSessionSidePanel((state) => state.setSidePanelOpen);
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

  async function saveTitle(): Promise<void> {
    const nextTitle = titleDraft.trim();
    if (!session || !nextTitle || titleSaving) return;
    if (nextTitle === session.title) {
      setTitleOpen(false);
      return;
    }
    setTitleSaving(true);
    try {
      await useSessionStore.getState().renameSession(sessionId, nextTitle);
      setTitleOpen(false);
    } catch (error) {
      showToast(
        error instanceof Error ? `重命名会话失败: ${error.message}` : '重命名会话失败',
        { variant: 'danger' },
      );
    } finally {
      setTitleSaving(false);
    }
  }

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-[var(--ema-border)] px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="i-lucide:folder shrink-0 text-sm text-[var(--ema-text-secondary)]" aria-hidden />
        <Button
          variant="ghost"
          disabled={!session}
          className="h-auto max-w-56 min-w-0 px-1 py-0.5 text-sm text-[var(--ema-text-primary)]"
          title={`重命名会话: ${title}`}
          onClick={() => {
            setTitleDraft(title);
            setTitleOpen(true);
          }}
        >
          <span className="truncate">{title}</span>
        </Button>
        {cwd && (
          <Button
            variant="ghost"
            className="h-auto max-w-72 min-w-0 px-2 py-1 text-xs font-normal text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)]"
            title={`执行目录: ${cwd} · 点击修改`}
            onClick={() => setCwdOpen(true)}
          >
            <span className="text-[var(--ema-text-tertiary)]" aria-hidden>·</span>
            <span className="truncate">{cwd}</span>
          </Button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Popover
          open={summaryOpen}
          onOpenChange={setSummaryOpen}
          side="bottom"
          align="end"
          widthClass="w-72"
          trigger={(
            <Button
              variant="secondary"
              className={`relative h-9 w-9 rounded-full p-0 ${summaryOpen
                ? 'border-[var(--ema-primary)]/70 bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)]'
                : ''}`}
              aria-label="置顶摘要"
              title="置顶摘要"
            >
              <span className="i-lucide:panel-top text-lg" aria-hidden />
              {runningAgentRunCount > 0 && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--ema-primary)] px-0.5 text-[9px] font-bold text-[var(--ema-text-primary)]">
                  {runningAgentRunCount}
                </span>
              )}
            </Button>
          )}
        >
          <SessionSummary sessionId={sessionId} />
        </Popover>
        <IconButton
          size="md"
          label={layout?.open ? '折叠右侧栏' : '展开右侧栏'}
          icon="i-lucide:panel-right"
          toggled={layout?.open ?? false}
          onClick={() => setSidePanelOpen(sessionId, !(layout?.open ?? false))}
        />
      </div>
      <SessionCwdDialog sessionId={sessionId} open={cwdOpen} onOpenChange={setCwdOpen} />
      <Dialog open={titleOpen} onOpenChange={setTitleOpen} title="重命名会话">
        <form onSubmit={(event) => { event.preventDefault(); void saveTitle(); }}>
          <Input
            aria-label="会话标题"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTitleOpen(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={!titleDraft.trim() || titleSaving}>
              {titleSaving ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </Dialog>
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
    // 不用加入 cwd 参数 后端会根据 sessionId 自动获取 cwd
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
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-1 py-1 text-left text-xs font-normal"
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
        </Button>
      </section>
      <section>
        <SectionTitle>附件</SectionTitle>
        {sources === undefined ? (
          <p className="px-1 text-[var(--ema-text-tertiary)]">加载中…</p>
        ) : sources.length === 0 ? (
          <p className="px-1 text-[var(--ema-text-tertiary)]">暂无来源</p>
        ) : (
          <>
            {sources.slice(0, SOURCE_PREVIEW_COUNT).map((source) => (
              <Button
                key={source.path}
                variant="ghost"
                className="h-auto w-full justify-start gap-2 px-1 py-1 text-left text-xs font-normal"
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
              </Button>
            ))}
            <Button
              variant="ghost"
              className="mt-1 h-auto px-1 py-0 text-xs font-normal text-[var(--ema-primary)] hover:underline"
              onClick={() => openTab(sessionId, { id: 'sources', kind: 'sources' })}
            >
              查看全部
              {sources.length > SOURCE_PREVIEW_COUNT ? ` (${sources.length})` : ''}
            </Button>
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
