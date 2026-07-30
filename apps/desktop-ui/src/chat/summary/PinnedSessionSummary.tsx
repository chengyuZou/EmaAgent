// 置顶摘要浮层：工作区事实、运行活动计数与来源概况，点击打开对应工作区标签。
import { useEffect, type JSX } from 'react';
import type { SessionId } from '@ema-agent/ids';
import { useAgentRunStore } from '../../stores/agentRunStore.js';
import { useSessionAttachmentStore } from '../../stores/session-attachment-store.js';
import { useSessionStore } from '../../stores/session-store.js';
import { useWorkspaceStore } from '../workspace/workspaceStore.js';

const SOURCES_PREVIEW_COUNT = 3;

export interface PinnedSessionSummaryProps {
  sessionId: SessionId;
}

export function PinnedSessionSummary({ sessionId }: PinnedSessionSummaryProps): JSX.Element {
  const openTab = useWorkspaceStore((s) => s.openTab);

  const workspaceRoot = useSessionStore((s) =>
    s.sessions.byId.get(sessionId as string)?.workspaceRoot ?? null);

  const activity = useAgentRunStore((s) => {
    let running = 0;
    let terminal = 0;
    for (const run of s.runs.values()) {
      if (run.sessionId !== (sessionId as string)) continue;
      if (run.status === 'running') running += 1;
      else terminal += 1;
    }
    return { running, terminal, total: running + terminal };
  });

  const attachments = useSessionAttachmentStore((s) =>
    s.bySession.get(sessionId as string));
  const loadAttachments = useSessionAttachmentStore((s) => s.loadForSession);
  useEffect(() => {
    void loadAttachments(sessionId);
  }, [sessionId, loadAttachments]);

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      {/* 环境信息：Git 行在只读来源（批次 D2）就绪前不渲染；V1 只有本地环境。 */}
      <section>
        <SectionTitle label="环境信息" />
        <div className="flex items-center gap-2 px-1 py-0.5 text-[var(--ema-text-secondary)]">
          <span className="i-lucide:monitor text-sm shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
          <span className="shrink-0">本地</span>
          {workspaceRoot && (
            <span className="truncate text-[var(--ema-text-tertiary)]" title={workspaceRoot}>
              {workspaceRoot}
            </span>
          )}
        </div>
      </section>

      {/* 运行活动：后台进程行在后端 API（批次 F）就绪前不渲染。 */}
      <section>
        <SectionTitle label="运行活动" />
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
              {activity.terminal > 0 && (
                <span className="text-[var(--ema-text-tertiary)]">○ {activity.terminal} 已完成</span>
              )}
            </>
          )}
        </SummaryRow>
      </section>

      {/* 来源：当前 Session 的附件，截断后由"查看全部"打开 sources 标签。 */}
      <section>
        <SectionTitle label="来源" />
        {attachments === undefined ? (
          <div className="px-1 py-0.5 text-[var(--ema-text-tertiary)]">加载中…</div>
        ) : attachments.length === 0 ? (
          <div className="px-1 py-0.5 text-[var(--ema-text-tertiary)]">暂无附件</div>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              {attachments.slice(0, SOURCES_PREVIEW_COUNT).map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 px-1 py-0.5 text-[var(--ema-text-secondary)]"
                  title={a.name}
                >
                  <span className={`${attachmentIcon(a.mimeType)} text-sm shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
                  <span className="truncate">{a.name}</span>
                </div>
              ))}
            </div>
            <button
              className="flex items-center gap-1.5 px-1 pt-1 text-[var(--ema-primary)] hover:text-[var(--ema-primary-hover)] transition-colors"
              onClick={() => openTab(sessionId, { id: 'sources', kind: 'sources' })}
            >
              <span className="i-lucide:link text-xs" aria-hidden />
              查看全部{attachments.length > SOURCES_PREVIEW_COUNT ? `（${attachments.length}）` : ''}
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

function attachmentIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'i-mdi:image-outline';
  if (mimeType === 'application/pdf') return 'i-mdi:file-pdf-box';
  if (mimeType.startsWith('text/')) return 'i-mdi:file-document-outline';
  return 'i-lucide:paperclip';
}
