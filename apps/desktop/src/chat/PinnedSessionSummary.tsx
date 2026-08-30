// 置顶摘要浮层：当前 Session 的环境、附件、任务和活动索引。
import { useEffect, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { sessionGitApi, type SessionGitSummary } from '../api/git.js';
import { useAgentRunStore } from '../stores/agentRun.js';
import { useBackgroundProcessStore } from '../stores/backgroundProcess.js';
import { useSessionAttachmentStore } from '../stores/sessionAttachment.js';
import { useSessionStore } from '../stores/session.js';
import { useTaskStore } from '../stores/task.js';
import { sessionAttachmentTab, useDockTabs } from './frame/dockTabs.js';
import { openReview } from './frame/tabs/review/reviewNavigation.js';

const ATTACHMENT_PREVIEW_COUNT = 3;

export interface PinnedSessionSummaryProps {
  sessionId: string;
}

export function PinnedSessionSummary({ sessionId }: PinnedSessionSummaryProps): JSX.Element {
  const openTab = useDockTabs((s) => s.openTab);

  const workspaceRoot = useSessionStore((s) =>
    s.sessions.byId.get(sessionId)?.workspaceRoot ?? null);

  const [git, setGit] = useState<SessionGitSummary | null>(null);
  useEffect(() => {
    if (!workspaceRoot) {
      setGit(null);
      return;
    }
    let current = true;
    void sessionGitApi.summary(sessionId).then((summary) => {
      if (current) setGit(summary);
    }).catch(() => {
      if (current) setGit(null);
    });
    return () => { current = false; };
  }, [sessionId, workspaceRoot]);

  const activity = useAgentRunStore(useShallow((s) => {
    let ended = 0;
    const runningIds = new Set<string>();
    for (const run of s.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.status === 'running') runningIds.add(run.id);
      else ended += 1;
    }
    for (const [id, entry] of s.live) {
      if (entry.sessionId === sessionId) runningIds.add(id);
    }
    const running = runningIds.size;
    return { running, ended, total: running + ended };
  }));
  const loadAgentRuns = useAgentRunStore((s) => s.loadForSession);
  useEffect(() => {
    void loadAgentRuns(sessionId);
  }, [sessionId, loadAgentRuns]);

  const loadTasks = useTaskStore((s) => s.loadForSession);
  useEffect(() => {
    void loadTasks(sessionId).catch(() => {});
  }, [sessionId, loadTasks]);
  const taskActivity = useTaskStore(useShallow((s) => {
    const tasks = s.tasksBySession.get(sessionId);
    let active = 0;
    let completed = 0;
    for (const task of tasks?.values() ?? []) {
      if (task.status === 'pending' || task.status === 'in_progress') active += 1;
      else completed += 1;
    }
    return { active, completed, total: active + completed };
  }));

  const attachments = useSessionAttachmentStore((s) =>
    s.bySession.get(sessionId));
  const loadAttachments = useSessionAttachmentStore((s) => s.loadForSession);
  useEffect(() => {
    void loadAttachments(sessionId);
  }, [sessionId, loadAttachments]);

  // 后台进程计数:面板同源 store,点击打开 backgroundProcesses 标签。
  const loadProcesses = useBackgroundProcessStore((s) => s.loadForSession);
  useEffect(() => {
    void loadProcesses(sessionId);
  }, [sessionId, loadProcesses]);
  const processes = useBackgroundProcessStore(useShallow((s) => {
    let running = 0;
    let ended = 0;
    for (const p of s.listsBySession.get(sessionId)?.processes ?? []) {
      if (p.status === 'running' || p.status === 'queued') running += 1;
      else ended += 1;
    }
    return { running, ended, total: running + ended };
  }));

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      {workspaceRoot && (
        <section>
          <SectionTitle label="环境信息" />
          {git?.capability === 'ok' && (
            <SummaryRow icon="i-lucide:file-diff" label="变更" onClick={() => openReview(sessionId, { kind: 'workspace' })}>
              <GitChangeCounts git={git} />
            </SummaryRow>
          )}
          <SummaryRow icon="i-lucide:monitor" label="本地" onClick={() => openTab(sessionId, { id: 'files', kind: 'files' })}>
            <span className="truncate text-[var(--ema-text-tertiary)]" title={workspaceRoot}>{workspaceRoot}</span>
          </SummaryRow>
          {git?.capability === 'ok' && (
            <div className="flex items-center gap-2 px-1 py-0.5 text-[var(--ema-text-secondary)]">
              <span className="i-lucide:git-branch shrink-0 text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
              <span className="truncate">{git.branch ?? (git.headShortSha ? `detached @ ${git.headShortSha}` : '空仓库')}</span>
            </div>
          )}
        </section>
      )}

      {/* Session 活动只做轻量索引，详情进入对应 Dock 标签。 */}
      <section>
        <SectionTitle label="Session 活动" />
        <SummaryRow
          icon="i-lucide:list-checks"
          label="任务"
          disabled={taskActivity.total === 0}
          onClick={() => openTab(sessionId, { id: 'tasks', kind: 'tasks' })}
        >
          {taskActivity.total === 0 ? (
            <span className="text-[var(--ema-text-tertiary)]">无记录</span>
          ) : (
            <>
              {taskActivity.active > 0 && <span className="text-[var(--ema-primary)]">● {taskActivity.active} 进行中</span>}
              {taskActivity.completed > 0 && <span className="text-[var(--ema-text-tertiary)]">○ {taskActivity.completed} 已结束</span>}
            </>
          )}
        </SummaryRow>
        <SummaryRow
          icon="i-solar:cpu-bold-duotone"
          label="子智能体"
          disabled={activity.total === 0}
          onClick={() => openTab(sessionId, { id: 'agentRuns', kind: 'agentRuns' })}
        >
          {activity.total === 0 ? (
            <span className="text-[var(--ema-text-tertiary)]">无记录</span>
          ) : (
            <>
              {activity.running > 0 && (
                <span className="text-[var(--ema-primary)]">● {activity.running} 运行中</span>
              )}
              {activity.ended > 0 && (
                <span className="text-[var(--ema-text-tertiary)]">○ {activity.ended} 已结束</span>
              )}
            </>
          )}
        </SummaryRow>
        <SummaryRow
          icon="i-lucide:square-terminal"
          label="后台进程"
          disabled={processes.total === 0}
          onClick={() => openTab(sessionId, { id: 'backgroundProcesses', kind: 'backgroundProcesses' })}
        >
          {processes.total === 0 ? (
            <span className="text-[var(--ema-text-tertiary)]">无记录</span>
          ) : (
            <>
              {processes.running > 0 && (
                <span className="text-[var(--ema-primary)]">● {processes.running} 运行中</span>
              )}
              {processes.ended > 0 && (
                <span className="text-[var(--ema-text-tertiary)]">○ {processes.ended} 已结束</span>
              )}
            </>
          )}
        </SummaryRow>
      </section>

      {/* 附件预览可直接打开，完整列表进入附件标签。 */}
      <section>
        <SectionTitle label="附件" />
        {attachments === undefined ? (
          <div className="px-1 py-0.5 text-[var(--ema-text-tertiary)]">加载中…</div>
        ) : attachments.length === 0 ? (
          <div className="px-1 py-0.5 text-[var(--ema-text-tertiary)]">暂无附件</div>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              {attachments.slice(0, ATTACHMENT_PREVIEW_COUNT).map((a) => (
                <button
                  key={a.id}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[var(--ema-text-secondary)] transition-colors hover:bg-[var(--ema-surface-2)]"
                  title={a.name}
                  onClick={() => openTab(sessionId, sessionAttachmentTab(a.id))}
                >
                  <span className={`${attachmentIcon(a.mimeType)} text-sm shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
                  <span className="truncate">{a.name}</span>
                </button>
              ))}
            </div>
            <button
              className="flex items-center gap-1.5 px-1 pt-1 text-[var(--ema-primary)] hover:text-[var(--ema-primary-hover)] transition-colors"
              onClick={() => openTab(sessionId, { id: 'attachments', kind: 'attachments' })}
            >
              <span className="i-lucide:link text-xs" aria-hidden />
              查看全部{attachments.length > ATTACHMENT_PREVIEW_COUNT ? `（${attachments.length}）` : ''}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function SectionTitle({ label }: { label: string }): JSX.Element {
  return (
    <div className="px-1 pb-1 text-[11px] font-medium text-[var(--ema-text-tertiary)]">
      {label}
    </div>
  );
}

function SummaryRow({
  icon, label, disabled, onClick, children,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      className={`w-full flex items-center gap-2 px-1 py-0.5 rounded-md text-left transition-colors ${
        disabled
          ? 'cursor-default'
          : 'hover:bg-[var(--ema-surface-2)] cursor-pointer'
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`${icon} text-sm shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
      <span className="shrink-0 text-[var(--ema-text-secondary)]">{label}</span>
      <span className="flex items-center gap-2 truncate">{children}</span>
    </button>
  );
}

/** Git 行的变更计数:合并未暂存与已暂存,全零时如实显示"无变更"。 */
function GitChangeCounts({ git }: { git: Extract<SessionGitSummary, { capability: 'ok' }> }): JSX.Element {
  const files = git.unstaged.filesChanged + git.staged.filesChanged;
  const insertions = git.unstaged.insertions + git.staged.insertions;
  const deletions = git.unstaged.deletions + git.staged.deletions;
  if (files === 0 && git.untrackedCount === 0) {
    return <span className="text-[var(--ema-text-tertiary)]">无变更</span>;
  }
  return (
    <>
      {files > 0 && (
        <span className="text-[var(--ema-text-tertiary)]">
          {files} 个文件 <span className="text-[var(--ema-success)]">+{insertions}</span>{' '}
          <span className="text-[var(--ema-danger)]">-{deletions}</span>
        </span>
      )}
      {git.untrackedCount > 0 && (
        <span className="text-[var(--ema-text-tertiary)]">{git.untrackedCount} 未跟踪</span>
      )}
    </>
  );
}

function attachmentIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'i-mdi:image-outline';
  if (mimeType === 'application/pdf') return 'i-mdi:file-pdf-box';
  if (mimeType.startsWith('text/')) return 'i-mdi:file-document-outline';
  return 'i-lucide:paperclip';
}
