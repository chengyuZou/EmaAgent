// 展示当前 Session 的子智能体：已开启/完成分组列表与标签内详情导航。
// 持久记录来自 Route；在途运行叠加 SSE 实时缓冲，终态后只剩持久记录。
import { useState, useEffect, useMemo, useRef, type JSX, type CSSProperties } from 'react';
import { Badge, Button, Spinner, type BadgeVariant } from '@ema-agent/ui';
import {
  useAgentRunStore,
  type LiveAgentRun,
  type LiveTranscriptEntry,
} from '../../../../stores/agentRun.js';
import type { AgentRunSummary } from '../../../../api/agentRuns.js';
import type { AgentRunMessage } from '@ema-agent/agent';
import type { ToolResult } from '@ema-agent/tools';

const TERMINAL_PAGE_SIZE = 10;

type AgentRunStatusValue = AgentRunSummary['status'];

/** 列表行：持久记录与实时缓冲可同时存在（在途运行刚落库后两者都有）。 */
interface AgentRunRowData {
  readonly id: string;
  readonly record?: AgentRunSummary;
  readonly live?: LiveAgentRun;
}

export interface AgentRunPanelProps {
  sessionId: string | null;
  className?: string;
  /** 深链标签（agentRun:<id>）初始打开的执行详情；列表标签不传。 */
  initialDetailId?: string;
}

export function AgentRunPanel({ sessionId, className = '', initialDetailId }: AgentRunPanelProps): JSX.Element {
  const runs           = useAgentRunStore((s) => s.runs);
  const live           = useAgentRunStore((s) => s.live);
  const loadForSession = useAgentRunStore((s) => s.loadForSession);

  const [detailId, setDetailId] = useState<string | null>(initialDetailId ?? null);
  const [visibleCount, setVisibleCount] = useState(TERMINAL_PAGE_SIZE);

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId);
  }, [sessionId, loadForSession]);

  const sessionRows = useMemo(() => {
    const byId = new Map<string, AgentRunRowData>();
    if (sessionId) {
      for (const run of runs.values()) {
        if (run.sessionId === sessionId) byId.set(run.id, { id: run.id, record: run });
      }
      for (const [id, entry] of live) {
        if (entry.sessionId === sessionId) byId.set(id, { ...byId.get(id), id, live: entry });
      }
    }
    return [...byId.values()].sort(
      (a, b) => rowTime(b) - rowTime(a),
    );
  }, [runs, live, sessionId]);

  const running  = sessionRows.filter((row) => rowStatus(row) === 'running');
  const terminal = sessionRows.filter((row) => rowStatus(row) !== 'running');

  if (detailId) {
    return (
      <AgentRunDetail
        agentRunId={detailId}
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
            <AgentRunRow key={row.id} row={row} staggerIndex={i} onOpen={() => setDetailId(row.id)} />
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
              <AgentRunRow
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

function rowStatus(row: AgentRunRowData): AgentRunStatusValue {
  return row.live ? 'running' : row.record?.status ?? 'running';
}

function rowTime(row: AgentRunRowData): number {
  return row.record?.createdAt ?? row.live?.startedAtMs ?? 0;
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-2 pt-0.5 pb-0.5 text-xs font-medium tracking-wider uppercase text-[var(--ema-text-tertiary)]">
      {children}
    </div>
  );
}

// ── 列表行 ────────────────────────────────────────────────────────────────────

function AgentRunRow({
  row, onOpen, staggerIndex = 0,
}: {
  row: AgentRunRowData;
  onOpen(): void;
  staggerIndex?: number;
}): JSX.Element {
  const status = rowStatus(row);
  const { icon, color } = statusMeta(status);

  const title = row.record?.description ?? row.live?.description
    ?? row.record?.modelId ?? row.live?.modelId ?? '子智能体';
  const summary = row.live
    ? `轮次 ${row.live.iteration} · 工具 ${row.live.toolCallCount}`
    : row.record
      ? (row.record.error
          ?? [
            row.record.iterations != null ? `${row.record.iterations} 轮次` : null,
            row.record.toolCallCount != null ? `${row.record.toolCallCount} 个工具` : null,
          ].filter(Boolean).join(' · '))
      : '';
  const at = row.record?.completedAt ?? row.record?.updatedAt ?? row.live?.startedAtMs;

  return (
    <div
      className="relative rounded-lg overflow-hidden cursor-pointer transition-all flex ema-stagger-in bg-[var(--ema-surface-1)] border border-[var(--ema-border)] hover:border-[var(--ema-border-hover)]"
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
      </div>
    </div>
  );
}

// ── 详情页（标签内导航） ───────────────────────────────────────────────────────

function AgentRunDetail({
  agentRunId, className, onBack,
}: {
  agentRunId: string;
  className?: string;
  onBack(): void;
}): JSX.Element {
  const record = useAgentRunStore((s) => s.runs.get(agentRunId));
  const live   = useAgentRunStore((s) => s.live.get(agentRunId));
  const status: AgentRunStatusValue = live ? 'running' : record?.status ?? 'cancelled';
  const { icon, color } = statusMeta(status);
  const exists = record !== undefined || live !== undefined;

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
              {record?.description ?? live?.description ?? '子智能体'}
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
            <span>{live?.modelId ?? record?.modelId ?? 'subagent'}</span>
            {live && (
              <>
                <span>轮次 {live.iteration}</span>
                <span>工具 {live.toolCallCount}</span>
              </>
            )}
            {!live && record?.iterations != null && <span>{record.iterations} 轮次</span>}
            {!live && record?.toolCallCount != null && <span>{record.toolCallCount} 个工具</span>}
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

          {/* 执行记录 */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <AgentRunTranscript agentRunId={agentRunId} />
          </div>
        </>
      )}
    </div>
  );
}

function AgentRunTranscript({ agentRunId }: { agentRunId: string }): JSX.Element {
  const loadTranscript = useAgentRunStore((s) => s.loadTranscript);
  const liveEntries    = useAgentRunStore((s) => s.liveTranscripts.get(agentRunId));
  const messages       = useAgentRunStore((s) => s.transcripts.get(agentRunId));

  useEffect(() => {
    // 在途运行渲染实时缓冲；缓冲不存在时才需要持久回放。
    if (liveEntries === undefined && messages === undefined) void loadTranscript(agentRunId);
  }, [agentRunId, liveEntries, messages, loadTranscript]);

  if (liveEntries !== undefined) {
    if (liveEntries.length === 0) {
      return (
        <div className="py-3 px-3 text-xs text-center text-[var(--ema-text-tertiary)]">
          等待执行输出…
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {liveEntries.map((entry, index) => (
          <div key={`${entry.role}-${index}`} className="ema-timeline-row">
            <TranscriptRow entry={entry} />
          </div>
        ))}
      </div>
    );
  }

  if (messages === null || messages === undefined) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size="sm" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="py-3 px-3 text-xs text-center text-[var(--ema-text-tertiary)]">
        无对话记录
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      {messages.map((msg) => (
        <div key={msg.id} className="ema-timeline-row">
          <TranscriptRow entry={msg} />
        </div>
      ))}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      mountedRef.current = true;
      return undefined;
    }
    if (mountedRef.current) {
      const t = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  return (
    <div className="py-0.5">
      <button
        className="flex items-center gap-1 text-xs select-none w-full text-left
                   transition-colors duration-[var(--ema-duration-base)] text-[var(--ema-text-tertiary)]"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="i-lucide:brain text-sm" />
        <span>思考过程</span>
        <span
          className="ml-auto text-[10px] i-lucide:chevron-down transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <p
              className="mt-1 text-xs whitespace-pre-wrap break-words selectable pl-4 ema-fade-in text-[var(--ema-text-tertiary)]"
              style={{ fontStyle: 'italic' }}
            >
              {text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** 两种真实来源同一渲染：实时缓冲条目（平铺字段）或持久 AgentRunMessage（content 嵌套）。 */
function TranscriptRow({ entry }: { entry: LiveTranscriptEntry | AgentRunMessage }): JSX.Element | null {
  switch (entry.role) {
    case 'reasoning':
      return <ReasoningBlock text={'content' in entry ? entry.content.text : entry.text} />;

    case 'assistant':
      return (
        <p className="text-xs py-1 whitespace-pre-wrap break-words selectable text-[var(--ema-text-primary)]">
          {'content' in entry ? entry.content.text : entry.text}
        </p>
      );

    case 'tool_call': {
      const name = 'content' in entry ? entry.content.name : entry.name;
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          <span className="i-lucide:square-code text-sm flex-shrink-0 text-[var(--ema-primary)]" />
          <span className="text-xs font-mono text-[var(--ema-primary)]">{name}</span>
        </div>
      );
    }

    case 'tool_result': {
      const result: ToolResult = 'content' in entry ? entry.content : entry.result;
      const excerpt = toolResultExcerpt(result.content);
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          <span
            className={`text-sm flex-shrink-0 mt-0.5 ${result.isError ? 'i-lucide:circle-alert' : 'i-lucide:circle-check'} ${result.isError ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-success)]'}`}
          />
          <span className={`text-xs truncate selectable ${result.isError ? 'text-[var(--ema-danger-text)]' : 'text-[var(--ema-text-secondary)]'}`}>
            {excerpt || (result.isError ? '失败' : '完成')}
          </span>
          {result.durationMs !== undefined && (
            <span className="ml-auto text-xs flex-shrink-0 text-[var(--ema-text-tertiary)]">
              {result.durationMs}ms
            </span>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

/** 从模型投影内容取一行纯文本摘要；媒体块没有文本时回退空串。 */
function toolResultExcerpt(content: ToolResult['content']): string {
  if (typeof content === 'string') return content;
  const text = content.find((part) => part.type === 'text');
  return text && 'text' in text ? text.text : '';
}

const STATUS_LABEL: Record<AgentRunStatusValue, string> = {
  running:      '运行中',
  completed:    '已完成',
  failed:       '失败',
  cancelled:    '已取消',
};

const STATUS_BADGE_VARIANT: Record<AgentRunStatusValue, BadgeVariant> = {
  running:      'primary',
  completed:    'success',
  failed:       'danger',
  cancelled:    'neutral',
};

type StatusMeta = { icon: string; color: string };

function statusMeta(status: AgentRunStatusValue): StatusMeta {
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
