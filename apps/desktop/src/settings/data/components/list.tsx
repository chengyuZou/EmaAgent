import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Button, EmptyState, Skeleton, Tooltip } from '@ema-agent/ui';
import type { SessionSummary } from '../../../api/sessions.js';
import { storageStatsApi, type DataDirStats, type SessionStats } from '../../../api/storageStats.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';
import { formatSessionTitle } from '../../../stores/session.js';
import { subscribeStorageChanges } from '../storageEvents.js';
import { fmtBytes, fmtDateShort, fmtDuration, fmtTokens } from '../storageFormat.js';
import type { StorageDetailTarget } from './detail.js';

interface StorageListProps {
  readonly stats: DataDirStats | null;
  readonly sessions: readonly SessionSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly openSessionId: string | null;
  readonly exportingSessionId: string | null;
  readonly exportDisabled: boolean;
  readonly onToggle: (sessionId: string) => void;
  readonly onExport: (session: SessionSummary) => void;
  readonly onOpenDetail: (target: StorageDetailTarget, source: HTMLElement) => void;
}

export function StorageList(props: StorageListProps): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {props.stats && <Overview stats={props.stats} />}
      <div className="flex flex-col gap-2">
        {props.loading && props.sessions.length === 0 && (
          [0, 1, 2].map(index => <Skeleton key={index} className="h-16 rounded-xl" />)
        )}
        {props.error && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-[var(--ema-danger)]">
            <span>{props.error}</span>
            <Button variant="ghost" size="sm" onClick={props.onRetry}>重试</Button>
          </div>
        )}
        {!props.loading && !props.error && props.sessions.length === 0 && (
          <EmptyState
            icon="i-solar:inbox-archive-bold-duotone"
            title="还没有会话"
            hint="开始一段对话，或导入会话备份"
            className="py-14"
          />
        )}
        {props.sessions.map((session, index) => (
          <SessionRow
            key={session.id}
            session={session}
            index={index}
            open={props.openSessionId === session.id}
            exporting={props.exportingSessionId === session.id}
            exportDisabled={props.exportDisabled}
            onToggle={props.onToggle}
            onExport={props.onExport}
            onOpenDetail={props.onOpenDetail}
          />
        ))}
      </div>
    </div>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  index,
  open,
  exporting,
  exportDisabled,
  onToggle,
  onExport,
  onOpenDetail,
}: {
  readonly session: SessionSummary;
  readonly index: number;
  readonly open: boolean;
  readonly exporting: boolean;
  readonly exportDisabled: boolean;
  readonly onToggle: StorageListProps['onToggle'];
  readonly onExport: StorageListProps['onExport'];
  readonly onOpenDetail: StorageListProps['onOpenDetail'];
}): JSX.Element {
  const { containerRef, mounted } = useCollapsibleBody(open);
  const { stats, failed, refresh } = useSessionCounts(session.id, open);
  const title = session.title || '未命名会话';
  const messageCount = stats?.messageCount ?? session.messageCount;
  const tokens = (stats?.totalInputTokens ?? session.totalInputTokens)
    + (stats?.totalOutputTokens ?? session.totalOutputTokens);
  return (
    <div
      className="ema-stagger-in overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)]"
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <div className="ema-card-decorate ema-card-decorate--lines flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
          onClick={() => onToggle(session.id)}
          aria-expanded={open}
        >
          <span className="i-solar:chat-round-bold-duotone text-[var(--ema-primary)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <Tooltip content={title} variant="card">
              <p className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">{formatSessionTitle(title)}</p>
            </Tooltip>
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              {fmtDateShort(session.lastActivityAt)} · {messageCount} 消息 · {fmtTokens(tokens)} Token
            </p>
          </div>
          <span
            className="i-lucide:chevron-down text-xs transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </button>
        <div className="shrink-0 pr-2">
          <Button
            variant="ghost"
            size="sm"
            loading={exporting}
            disabled={exportDisabled}
            onClick={() => onExport(session)}
          >
            <span className="i-solar:download-minimalistic-bold-duotone" aria-hidden />导出
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <SessionBlocks
              sessionId={session.id}
              sessionTitle={title}
              stats={stats}
              failed={failed}
              onRetry={refresh}
              onOpenDetail={onOpenDetail}
            />
          )}
        </div>
      </div>
    </div>
  );
});

function useSessionCounts(sessionId: string, open: boolean) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setFailed(false);
    void storageStatsApi.getSessionStats(sessionId, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setStats(result);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setFailed(true);
      }
    });
  }, [sessionId]);

  useEffect(() => {
    const unsubscribe = subscribeStorageChanges(sessionId, refresh);
    return () => {
      request.current?.abort();
      unsubscribe();
    };
  }, [sessionId, refresh]);
  useEffect(() => {
    if (open && stats === null) {
      refresh();
    }
  }, [open, stats, refresh]);
  // 只保留几个计数. 收起会话不丢弃它们, 也不缓存消息或媒体正文.
  return { stats, failed, refresh };
}

function SessionBlocks({ sessionId, sessionTitle, stats, failed, onRetry, onOpenDetail }: {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly stats: SessionStats | null;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly onOpenDetail: StorageListProps['onOpenDetail'];
}): JSX.Element {
  if (failed && stats === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        <p className="text-xs text-[var(--ema-danger)]">统计读取失败</p>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 px-4 pb-4">
        {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-16 rounded-xl" />)}
      </div>
    );
  }
  const blocks: {
    kind: StorageDetailTarget['kind'];
    label: string;
    value: string | number;
    sub?: string;
  }[] = [
    { kind: 'turns', label: '轮次', value: stats.turnCount },
    { kind: 'messages', label: '消息', value: stats.messageCount },
    {
      kind: 'token',
      label: 'Token',
      value: fmtTokens(stats.totalInputTokens + stats.totalOutputTokens),
      sub: `输入 ${fmtTokens(stats.totalInputTokens)} · 输出 ${fmtTokens(stats.totalOutputTokens)}`,
    },
    { kind: 'goals', label: '目标', value: stats.goalCount },
    { kind: 'attachments', label: '附件', value: stats.attachmentCount, sub: fmtBytes(stats.attachmentTotalBytes) },
    { kind: 'audio', label: '音频', value: stats.audioTurnCount, sub: fmtDuration(stats.audioTotalDurationMs) },
    { kind: 'subagents', label: '子代理', value: stats.subagentCount },
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 border-t border-[var(--ema-border)] px-4 py-3">
      {failed && (
        <div className="col-span-full flex items-center gap-2">
          <p className="text-xs text-[var(--ema-danger)]">刷新失败，保留已加载的统计</p>
          <Button variant="ghost" size="sm" onClick={onRetry}>重试</Button>
        </div>
      )}
      {blocks.map((block, index) => (
        <button
          key={block.kind}
          type="button"
          onClick={event => onOpenDetail({ kind: block.kind, sessionId, sessionTitle }, event.currentTarget)}
          className="ema-stagger-in ema-card-decorate ema-card-decorate--lines flex flex-col gap-0.5 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 py-2.5 text-left transition-colors hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-3)]"
          style={{ '--stagger-i': index } as CSSProperties}
        >
          <span className="text-[11px] text-[var(--ema-text-tertiary)]">{block.label}</span>
          <span className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">{block.value}</span>
          {block.sub && (
            <span className="truncate text-[10px] text-[var(--ema-text-tertiary)]">{block.sub}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function Overview({ stats }: { readonly stats: DataDirStats }): JSX.Element {
  const items = [
    { icon: 'i-solar:chat-round-bold-duotone', label: '会话', value: stats.sessionCount },
    { icon: 'i-solar:refresh-circle-bold-duotone', label: '轮次', value: stats.turnCount },
    { icon: 'i-solar:letter-bold-duotone', label: '消息', value: stats.messageCount },
    { icon: 'i-lucide:goal', label: '目标', value: stats.goalCount },
    { icon: 'i-solar:bolt-bold-duotone', label: 'Token', value: fmtTokens(stats.totalInputTokens + stats.totalOutputTokens) },
    { icon: 'i-solar:paperclip-bold-duotone', label: '附件', value: stats.attachmentCount },
    { icon: 'i-solar:soundwave-bold-duotone', label: '音频', value: stats.audioCount },
    { icon: 'i-solar:magic-stick-3-bold-duotone', label: '子代理', value: stats.subagentCount },
  ];
  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
        <span className="text-xs font-semibold">总览</span>
        {items.map(item => (
          <span key={item.label} className="flex items-center gap-1 text-xs text-[var(--ema-text-tertiary)]">
            <span className={`${item.icon} text-[var(--ema-primary)]`} aria-hidden />
            <span className="font-medium text-[var(--ema-text-primary)]">{item.value}</span>{item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
