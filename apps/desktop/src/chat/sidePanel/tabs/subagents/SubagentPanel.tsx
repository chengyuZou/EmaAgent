// 展示当前 Session 的子智能体：已开启/完成分组列表与标签内详情导航。
// 持久记录来自 Route；在途运行叠加 WebSocket 实时缓冲，终态后只剩持久记录。
import { useState, useEffect, useMemo, type JSX, type CSSProperties } from 'react';
import { Badge, Button, IconButton, Markdown, Spinner, type BadgeVariant } from '@ema-agent/ui';
import { sessionWebSocket } from '../../../../api/sessionWebSocket.js';
import { subagentsApi, type SubagentMessageItem, type SubagentSummary } from '../../../../api/subagents.js';
import {
  useSubagentStore,
  type SubagentProgress,
  type SubagentStreamingMessage,
} from '../../../../stores/subagent.js';
import type { ToolResult } from '@ema-agent/tools';
import { assistantOutputBlocks, useTurnStore } from '../../../../stores/turn.js';
import { AssistantSections, historyAssistantSections, useStableLiveSections } from '../../../messages/assistantSections.js';

const TERMINAL_PAGE_SIZE = 10;

type SubagentStatusValue = SubagentSummary['status'];

/** 列表行：持久记录与实时缓冲可同时存在（在途运行刚落库后两者都有）。 */
interface SubagentRowData {
  readonly id: string;
  readonly record?: SubagentSummary;
  readonly progress?: SubagentProgress;
}

export interface SubagentPanelProps {
  sessionId: string | null;
  className?: string;
  /** 深链标签（subagent:<id>）初始打开的执行详情；列表标签不传。 */
  initialDetailId?: string;
}

export function SubagentPanel({ sessionId, className = '', initialDetailId }: SubagentPanelProps): JSX.Element {
  const subagents      = useSubagentStore((s) => s.subagents);
  const progressById   = useSubagentStore((s) => s.progressById);
  const loadForSession = useSubagentStore((s) => s.loadForSession);
  const refreshSubagent = useSubagentStore((s) => s.refreshSubagent);

  const [detailId, setDetailId] = useState<string | null>(initialDetailId ?? null);
  const [visibleCount, setVisibleCount] = useState(TERMINAL_PAGE_SIZE);

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId);
  }, [sessionId, loadForSession]);

  useEffect(() => {
    setDetailId(initialDetailId ?? null);
  }, [initialDetailId]);

  useEffect(() => {
    if (detailId) void refreshSubagent(detailId);
  }, [detailId, refreshSubagent]);

  const sessionRows = useMemo(() => {
    const byId = new Map<string, SubagentRowData>();
    if (sessionId) {
      for (const subagent of subagents.values()) {
        if (subagent.sessionId === sessionId) {
          byId.set(subagent.id, { id: subagent.id, record: subagent });
        }
      }
      for (const [id, progress] of progressById) {
        if (progress.sessionId === sessionId) byId.set(id, { ...byId.get(id), id, progress });
      }
    }
    return [...byId.values()].sort(
      (a, b) => rowTime(b) - rowTime(a),
    );
  }, [subagents, progressById, sessionId]);

  const running  = sessionRows.filter((row) => rowStatus(row) === 'running');
  const terminal = sessionRows.filter((row) => rowStatus(row) !== 'running');

  if (detailId) {
    return (
      <SubagentDetail
        subagentId={detailId}
        className={className}
        onBack={() => setDetailId(null)}
      />
    );
  }

  return (
    <div className={`flex flex-col gap-1 overflow-y-auto ${className}`}>
      {/* 已开启：空也如实显示，不隐藏分区 */}
      <SectionLabel>已开启</SectionLabel>
      {running.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-[var(--ema-text-tertiary)]">没有已开启的子代理</p>
      ) : (
        <div className="flex flex-col gap-1">
          {running.map((row, i) => (
            <SubagentRow key={row.id} row={row} staggerIndex={i} onOpen={() => setDetailId(row.id)} />
          ))}
        </div>
      )}

      {/* 完成：聚合计数 + 截断分页；终态清理归 Session 生命周期，面板只读 */}
      {terminal.length > 0 && (
        <>
          <div className="flex items-center mt-2">
            <SectionLabel>{`完成 · ${terminal.length}`}</SectionLabel>
          </div>
          <div className="flex flex-col gap-1">
            {terminal.slice(0, visibleCount).map((row, i) => (
              <SubagentRow
                key={row.id}
                row={row}
                staggerIndex={running.length + i}
                onOpen={() => setDetailId(row.id)}
              />
            ))}
          </div>
          {terminal.length > visibleCount && (
            <Button
              variant="ghost"
              size="sm"
              className="self-center text-xs text-[var(--ema-text-tertiary)]"
              onClick={() => setVisibleCount((n) => n + TERMINAL_PAGE_SIZE)}
            >
              再显示 {Math.min(TERMINAL_PAGE_SIZE, terminal.length - visibleCount)} 个
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function rowStatus(row: SubagentRowData): SubagentStatusValue {
  return row.progress ? 'running' : row.record?.status ?? 'running';
}

function rowTime(row: SubagentRowData): number {
  return row.record?.createdAt ?? row.progress?.startedAtMs ?? 0;
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  // uppercase 对 CJK 是空操作还把两字标签字距拉稀; 中文分组标签靠字重+色分层.
  return (
    <div className="px-2 pt-0.5 pb-0.5 text-xs font-medium text-[var(--ema-text-tertiary)]">
      {children}
    </div>
  );
}

// ── 列表行 ────────────────────────────────────────────────────────────────────

function SubagentRow({
  row, onOpen, staggerIndex = 0,
}: {
  row: SubagentRowData;
  onOpen(): void;
  staggerIndex?: number;
}): JSX.Element {
  const status = rowStatus(row);
  const { icon, color } = statusMeta(status);
  const sessionId = row.progress?.sessionId ?? row.record?.sessionId;
  const invocations = useSubagentStore(state => sessionId
    ? state.invocationsBySession.get(sessionId)
    : undefined);
  const ownedByForegroundTool = useTurnStore(state => sessionId !== undefined && (
    [...(state.turnsBySession.get(sessionId)?.values() ?? [])].some(turn => (
      assistantOutputBlocks(turn).some(item => item.type === 'tool_use'
        && invocations?.get(item.callId) === row.id
        && (item.status === 'running' || item.status === 'awaiting_permission'))
    ))
  ));

  const title = row.record?.description ?? row.progress?.description
    ?? row.record?.modelId ?? row.progress?.modelId ?? '子智能体';
  const summary = row.progress
    ? `轮次 ${row.progress.iteration} · 工具 ${row.progress.toolCallCount}`
    : row.record
      ? (row.record.error
          ?? [
            row.record.iterations != null ? `${row.record.iterations} 轮次` : null,
            row.record.toolCallCount != null ? `${row.record.toolCallCount} 个工具` : null,
          ].filter(Boolean).join(' · '))
      : '';
  const at = row.record?.completedAt ?? row.record?.updatedAt ?? row.progress?.startedAtMs;

  return (
    <div
      className="relative rounded-lg overflow-hidden cursor-pointer transition-all flex ema-stagger-in bg-[var(--ema-surface-1)] border border-[var(--ema-border)] hover:border-[var(--ema-border-hover)] hover:shadow-[var(--ema-shadow-soft)]"
      style={{ '--stagger-i': staggerIndex } as CSSProperties}
      onClick={onOpen}
    >
      {status === 'running' && <div className="ema-running-bar" />}
      <div className="flex items-start gap-2 px-2.5 py-2 flex-1 min-w-0">
        <span className={`mt-0.5 text-base shrink-0 ${icon}`} style={{ color }} aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate text-[var(--ema-text-primary)]" title={title}>
            {title}
          </div>
          {summary && (
            <p className="text-[11px] mt-0.5 truncate text-[var(--ema-text-tertiary)]" title={summary}>
              {summary}
            </p>
          )}
        </div>
        {at !== undefined && (
          <span className="shrink-0 mt-0.5 text-[10px] tabular-nums text-[var(--ema-text-tertiary)]">
            {formatRelativeTime(at)}
          </span>
        )}
        {status === 'running' && !ownedByForegroundTool && (
          <IconButton
            label="中止子代理"
            icon="i-lucide:circle-stop"
            variant="danger"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              if (sessionId) void sessionWebSocket.cancelSubagent(sessionId, row.id);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── 详情页（标签内导航） ───────────────────────────────────────────────────────

function SubagentDetail({
  subagentId, className, onBack,
}: {
  subagentId: string;
  className?: string;
  onBack(): void;
}): JSX.Element {
  const record = useSubagentStore((s) => s.subagents.get(subagentId));
  const progress = useSubagentStore((s) => s.progressById.get(subagentId));
  const status: SubagentStatusValue = progress ? 'running' : record?.status ?? 'cancelled';
  const { icon, color } = statusMeta(status);
  const exists = record !== undefined || progress !== undefined;

  return (
    <div className={`flex flex-col min-h-0 h-full ${className}`}>
      {/* 返回 + 标题 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 border-b border-[var(--ema-border)]">
        <Button variant="ghost" size="sm" className="px-1.5 text-[var(--ema-text-tertiary)]" onClick={onBack}>
          <span className="i-lucide:arrow-left text-sm" aria-hidden />
        </Button>
        {exists && (
          <>
            <span className={`text-sm shrink-0 ${icon}`} style={{ color }} aria-hidden />
            <span className="text-xs font-medium truncate text-[var(--ema-text-primary)]">
              {record?.description ?? progress?.description ?? '子智能体'}
            </span>
            <Badge variant={STATUS_BADGE_VARIANT[status]} dot={status === 'running'}>
              {STATUS_LABEL[status]}
            </Badge>
          </>
        )}
      </div>

      {!exists ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--ema-text-tertiary)]">
          该执行记录不存在或已被清理
        </div>
      ) : (
        <>
          {/* 事实行：模型、轮次、工具、tokens、耗时——持久记录与实时缓冲各自如实呈现 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 shrink-0 text-[11px] text-[var(--ema-text-tertiary)] border-b border-[var(--ema-border)]">
            <span>{progress?.modelId ?? record?.modelId ?? 'subagent'}</span>
            {progress && (
              <>
                <span>轮次 {progress.iteration}</span>
                <span>工具 {progress.toolCallCount}</span>
              </>
            )}
            {!progress && record?.iterations != null && <span>{record.iterations} 轮次</span>}
            {!progress && record?.toolCallCount != null && <span>{record.toolCallCount} 个工具</span>}
            {record?.inputTokens != null && (
              <span>{((record.inputTokens + (record.outputTokens ?? 0)) / 1000).toFixed(1)}k tokens</span>
            )}
            {record?.completedAt != null && (
              <span>{formatElapsed(record.completedAt - record.createdAt)}</span>
            )}
          </div>
          {record?.error && (
            <p className="px-3 py-1.5 shrink-0 text-xs truncate text-[var(--ema-danger-text)] border-b border-[var(--ema-border)]">
              {record.error}
            </p>
          )}

          {/* 消息 */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SubagentMessages
              key={subagentId}
              subagentId={subagentId}
              sessionId={record?.sessionId ?? progress!.sessionId}
            />
          </div>
        </>
      )}
    </div>
  );
}

function SubagentMessages({
  subagentId,
  sessionId,
}: {
  subagentId: string;
  sessionId: string;
}): JSX.Element {
  const streamingMessages = useSubagentStore(state => state.streamingMessages.get(subagentId));
  const isStreaming = streamingMessages !== undefined;
  const [messages, setMessages] = useState<readonly SubagentMessageItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isStreaming) return;
    let active = true;
    setLoading(true);
    setError(null);
    void subagentsApi.listMessages(subagentId)
      .then(page => {
        if (!active) return;
        setMessages(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [subagentId, isStreaming]);

  const toolResults = useMemo(() => {
    const results = new Map<string, ToolResult>();
    for (const message of messages ?? []) {
      if (message.role !== 'user' || typeof message.blocks === 'string') continue;
      for (const block of message.blocks) {
        if (block.type === 'tool_result') {
          results.set(block.toolCallId, {
            ...block,
            content: typeof block.content === 'string' ? block.content : [...block.content],
          });
        }
      }
    }
    return results;
  }, [messages]);

  async function loadOlder(): Promise<void> {
    if (nextCursor === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await subagentsApi.listMessages(subagentId, nextCursor);
      setMessages(current => [...page.items, ...(current ?? [])]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  if (isStreaming) {
    const visible = streamingMessages.filter(message => message.blocks.length > 0);
    if (visible.length === 0) {
      return <div className="px-3 py-3 text-center text-xs text-[var(--ema-text-tertiary)]">等待执行输出…</div>;
    }
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        {visible.map(message => (
          <SubagentStreamingMessageView
            key={message.iteration}
            message={message}
            sessionId={sessionId}
          />
        ))}
      </div>
    );
  }

  if (messages === null && loading) {
    return <div className="flex justify-center py-4"><Spinner size="sm" /></div>;
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {error && <p className="text-xs text-[var(--ema-danger-text)]">{error}</p>}
      {nextCursor !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center text-xs text-[var(--ema-text-tertiary)]"
          disabled={loading}
          onClick={() => void loadOlder()}
        >
          {loading ? '正在加载…' : '加载更早消息'}
        </Button>
      )}
      {messages?.length === 0 && (
        <div className="py-3 text-center text-xs text-[var(--ema-text-tertiary)]">无消息记录</div>
      )}
      {messages?.map(message => (
        <SubagentStoredMessage
          key={message.id}
          message={message}
          toolResults={toolResults}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}

function SubagentStreamingMessageView({
  message,
  sessionId,
}: {
  message: SubagentStreamingMessage;
  sessionId: string;
}): JSX.Element {
  const sections = useStableLiveSections(message.blocks);
  return <AssistantSections sections={sections} streaming sessionId={sessionId} />;
}

function SubagentStoredMessage({
  message,
  toolResults,
  sessionId,
}: {
  message: SubagentMessageItem;
  toolResults: ReadonlyMap<string, ToolResult>;
  sessionId: string;
}): JSX.Element | null {
  if (message.role === 'assistant') {
    const sections = historyAssistantSections([message], toolResults);
    return <AssistantSections sections={sections} streaming={false} sessionId={sessionId} />;
  }

  if (message.kind === 'tool_results') return null;
  const text = typeof message.blocks === 'string'
    ? message.blocks
    : message.blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  if (!text) return null;
  return (
    <div className="rounded-lg bg-[var(--ema-surface-2)] px-3 py-2 text-xs text-[var(--ema-text-secondary)]">
      <Markdown source={text} />
    </div>
  );
}
const STATUS_LABEL: Record<SubagentStatusValue, string> = {
  running:      '运行中',
  completed:    '已完成',
  failed:       '失败',
  cancelled:    '已取消',
};

const STATUS_BADGE_VARIANT: Record<SubagentStatusValue, BadgeVariant> = {
  running:      'primary',
  completed:    'success',
  failed:       'danger',
  cancelled:    'neutral',
};

type StatusMeta = { icon: string; color: string };

function statusMeta(status: SubagentStatusValue): StatusMeta {
  switch (status) {
    case 'running':      return { icon: 'i-lucide:loader-circle animate-spin', color: 'var(--ema-primary)' };
    case 'completed':    return { icon: 'i-lucide:circle-check', color: 'var(--ema-success)' };
    case 'failed':       return { icon: 'i-lucide:circle-alert', color: 'var(--ema-danger)' };
    case 'cancelled':    return { icon: 'i-lucide:circle-x',               color: 'var(--ema-text-tertiary)' };
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/** 列表行的相对时间：1 分钟内"刚刚"，之后分钟/小时/天，超过 30 天显示日期。 */
function formatRelativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return '刚刚';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}
