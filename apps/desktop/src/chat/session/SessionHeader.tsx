import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Dialog, IconButton, Input, Popover } from '@ema-agent/ui';
import { sessionGitApi, type SessionGitSummary } from '../../api/git.js';
import { showToast } from '../../lib/toast.js';
import { useAgentRunStore } from '../../stores/agentRun.js';
import { useBackgroundProcessStore } from '../../stores/backgroundProcess.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useSessionStore } from '../../stores/session.js';
import { useTaskStore } from '../../stores/task.js';
import { SessionCwdDialog } from './SessionCwdDialog.js';
import {
  backgroundProcessTab,
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
          className="h-auto max-w-56 min-w-0 px-1 py-0.5 text-sm font-semibold text-[var(--ema-text-primary)] hover:bg-transparent"
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
            className="h-auto max-w-72 min-w-0 px-2 py-1 font-mono text-xs font-normal text-[var(--ema-text-tertiary)] hover:bg-transparent hover:text-[var(--ema-text-primary)]"
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
          widthClass="w-80"
          className="overflow-hidden p-0"
          trigger={(
            <Button
              variant="ghost"
              className={`chat-icon-btn relative ${summaryOpen
                ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)] border-[var(--ema-primary)]/40'
                : ''}`}
              aria-label="置顶摘要"
              title="置顶摘要"
            >
              <span className="i-lucide:sliders-horizontal text-base" aria-hidden />
            </Button>
          )}
        >
          <SessionSummary sessionId={sessionId} onNavigate={() => setSummaryOpen(false)} />
        </Popover>
        <IconButton
          size="md"
          className="chat-icon-btn"
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

function SessionSummary({
  sessionId,
  onNavigate,
}: {
  sessionId: string;
  onNavigate(): void;
}): JSX.Element {
  const openTab = useSessionSidePanel((state) => state.openTab);
  const cwd = useSessionStore((state) => (
    state.sessions.byId.get(sessionId)?.cwd ?? null
  ));
  const [git, setGit] = useState<SessionGitSummary | null>(null);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<ReadonlySet<string>>(new Set());
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
  const processList = useBackgroundProcessStore(state => state.listsBySession.get(sessionId));
  const tasks = useTaskStore(state => state.tasksBySession.get(sessionId));
  const liveProcesses = useMemo(
    () => [...(processList?.processes ?? [])]
      .filter(process => process.status === 'queued' || process.status === 'running')
      .sort((left, right) => right.createdAt - left.createdAt),
    [processList?.processes],
  );
  const taskCounts = useMemo(() => {
    let active = 0;
    let completed = 0;
    for (const task of tasks?.values() ?? []) {
      if (task.status === 'pending' || task.status === 'in_progress') active += 1;
      if (task.status === 'completed') completed += 1;
    }
    return { active, completed, total: tasks?.size ?? 0 };
  }, [tasks]);

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
  useEffect(() => { void useBackgroundProcessStore.getState().loadForSession(sessionId); }, [sessionId]);
  useEffect(() => { void useTaskStore.getState().loadForSession(sessionId); }, [sessionId]);

  const navigate = (tab: Parameters<typeof openTab>[1]): void => {
    openTab(sessionId, tab);
    onNavigate();
  };

  const stopProcess = async (processId: string): Promise<void> => {
    setStoppingProcessIds(current => new Set(current).add(processId));
    try {
      await useBackgroundProcessStore.getState().stop(sessionId, processId);
    } catch (error: unknown) {
      showToast(
        error instanceof Error ? `终止后台进程失败: ${error.message}` : '终止后台进程失败',
        { variant: 'danger' },
      );
    } finally {
      setStoppingProcessIds(current => {
        const next = new Set(current);
        next.delete(processId);
        return next;
      });
    }
  };

  return (
    <div className="ema-session-summary text-xs">
      <SummarySection title="环境信息">
        <SummaryRow
          icon="i-lucide:file-diff"
          label="变更"
          onClick={() => navigate({ id: 'review', kind: 'review' })}
        >
          <GitChanges git={git} />
        </SummaryRow>
        <SummaryRow icon="i-lucide:monitor" label="本地" title={cwd ?? undefined} />
        <SummaryRow
          icon="i-lucide:git-branch"
          label={git?.capability === 'ok' ? git.branch ?? '未命名分支' : '分支不可用'}
        />
      </SummarySection>

      <SummarySection title="子代理" summary={activity.running > 0 ? `${activity.running} 运行中` : undefined}>
        <SummaryRow
          icon="i-solar:cpu-bold-duotone"
          label={activity.running > 0 ? `${activity.running} 个运行中` : '暂无运行中的子代理'}
          onClick={() => navigate({ id: 'subagents', kind: 'subagents' })}
        >
          {activity.ended > 0 ? <span>{activity.ended} 已完成</span> : null}
        </SummaryRow>
      </SummarySection>

      <SummarySection title="后台进程" summary={liveProcesses.length > 0 ? `${liveProcesses.length} 运行中` : undefined}>
        {liveProcesses.length === 0 ? (
          <SummaryRow icon="i-lucide:square-terminal" label="暂无运行中的后台进程" />
        ) : liveProcesses.map(process => (
          <div key={process.id} className="ema-summary-process-row">
            <button
              type="button"
              className="ema-summary-row min-w-0 flex-1"
              title={process.command}
              onClick={() => navigate(backgroundProcessTab(process.id))}
            >
              <span className="i-lucide:square-terminal shrink-0 text-sm" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">
                {process.description ?? process.command}
              </span>
            </button>
            <IconButton
              size="sm"
              variant="danger"
              icon="i-lucide:square"
              label={`终止 ${process.description ?? process.command}`}
              loading={stoppingProcessIds.has(process.id)}
              onClick={() => void stopProcess(process.id)}
            />
          </div>
        ))}
      </SummarySection>

      <SummarySection title="Tasks" summary={taskCounts.active > 0 ? `${taskCounts.active} 待处理` : undefined}>
        <SummaryRow
          icon="i-lucide:list-checks"
          label={taskCounts.total > 0 ? `${taskCounts.active} 待处理` : '当前会话没有 Tasks'}
          onClick={() => navigate({ id: 'tasks', kind: 'tasks' })}
        >
          {taskCounts.completed > 0 ? <span>{taskCounts.completed} 已完成</span> : null}
        </SummaryRow>
      </SummarySection>

      <SummarySection title="附件" summary={sources && sources.length > 0 ? `${sources.length}` : undefined}>
        {sources === undefined ? (
          <SummaryRow icon="i-lucide:loader-circle animate-spin" label="正在读取附件…" />
        ) : sources.length === 0 ? (
          <SummaryRow icon="i-lucide:paperclip" label="当前会话没有附件" />
        ) : (
          <>
            {sources.slice(0, SOURCE_PREVIEW_COUNT).map(source => (
              <SummaryRow
                key={source.path}
                icon={source.kind === 'image' ? 'i-lucide:image' : 'i-lucide:file-text'}
                label={source.kind === 'image' ? source.name ?? '剪贴板图片' : '粘贴文本'}
                onClick={() => navigate(sessionSourceTab(source.path))}
              />
            ))}
            <SummaryRow
              icon="i-lucide:paperclip"
              label={sources.length > SOURCE_PREVIEW_COUNT ? `查看全部 ${sources.length} 个附件` : '查看全部附件'}
              onClick={() => navigate({ id: 'sources', kind: 'sources' })}
            />
          </>
        )}
      </SummarySection>
    </div>
  );
}

function SummarySection({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <section className="ema-summary-section">
      <button
        type="button"
        className="ema-summary-section-trigger"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span>{title}</span>
        {summary && <span className="ml-auto text-[10px] text-[var(--ema-text-tertiary)]">{summary}</span>}
        <span
          className={`i-lucide:chevron-down shrink-0 text-xs transition-transform ${open ? '' : '-rotate-90'}`}
          aria-hidden
        />
      </button>
      <div className="ema-collapsible" style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}>
        <div>
          <div className="pb-1">{children}</div>
        </div>
      </div>
    </section>
  );
}

function SummaryRow({
  icon,
  label,
  title,
  children,
  onClick,
}: {
  icon: string;
  label: string;
  title?: string;
  children?: ReactNode;
  onClick?: () => void;
}): JSX.Element {
  const content = (
    <>
      <span className={`${icon} text-sm text-[var(--ema-text-tertiary)]`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {children && <span className="shrink-0 text-[var(--ema-text-tertiary)]">{children}</span>}
      {onClick && <span className="i-lucide:chevron-right shrink-0 text-[10px] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
    </>
  );
  return onClick ? (
    <button type="button" className="ema-summary-row group" title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="ema-summary-row" title={title}>{content}</div>
  );
}

function GitChanges({ git }: { git: SessionGitSummary | null }): JSX.Element {
  if (!git || git.capability !== 'ok') {
    return <span className="text-[var(--ema-text-tertiary)]">不可用</span>;
  }
  const insertions = git.unstaged.insertions + git.staged.insertions;
  const deletions = git.unstaged.deletions + git.staged.deletions;
  if (insertions === 0 && deletions === 0 && git.untrackedCount === 0) {
    return <span className="text-[var(--ema-text-tertiary)]">无变更</span>;
  }
  return (
    <span className="flex items-center gap-1">
      <span className="text-[var(--ema-success)]">+{insertions}</span>{' '}
      <span className="text-[var(--ema-danger)]">-{deletions}</span>
    </span>
  );
}
