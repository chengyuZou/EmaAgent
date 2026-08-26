// 展示当前 Session 的子智能体：已开启/完成分组列表与标签内详情导航。
import { useState, useEffect, useMemo, useRef, type JSX, type CSSProperties } from 'react';
import { Badge, Button, Spinner, type BadgeVariant } from '@ema-agent/ui';
import { useAgentRunStore, type AgentRunState } from '../../stores/agentRunStore.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import type { AgentRunMessageItem } from '../../api/agentRuns.js';

// content 在传输层是 JSON 联合；以下展示投影与生产者 src/agent/runs/agentRunMessagesStore.ts
// 的落库字段一一对应。用 type 别名（隐式索引签名）保持与 hono JSONObject 可比，
// 字段全部 JSON 兼容以便按 role 判别后收窄，面板只消费这些字段。
type AgentRunTextContent = {
  readonly blockIndex: number;
  readonly text: string;
};

type AgentRunToolCallContent = {
  readonly blockIndex: number;
  readonly callId: string;
  readonly name: string;
};

type AgentRunToolResultPart = {
  readonly type: string;
  readonly text?: string;
};

type AgentRunToolResultContent = {
  readonly type: 'tool_result';
  readonly toolCallId: string;
  readonly content: string | readonly AgentRunToolResultPart[];
  readonly isError?: boolean;
  readonly durationMs?: number;
};

const TERMINAL_PAGE_SIZE = 10;

export interface AgentRunPanelProps {
  className?: string;
  /** 深链标签（agentRun:<id>）初始打开的执行详情；列表标签不传。 */
  initialDetailId?: string;
}

export function AgentRunPanel({ className = '', initialDetailId }: AgentRunPanelProps): JSX.Element {
  const sessionId      = useConversationStore((s) => s.viewedSessionId);
  const runs           = useAgentRunStore((s) => s.runs);
  const loadForSession = useAgentRunStore((s) => s.loadForSession);

  const [detailId, setDetailId] = useState<string | null>(initialDetailId ?? null);
  const [visibleCount, setVisibleCount] = useState(TERMINAL_PAGE_SIZE);

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId as string);
  }, [sessionId, loadForSession]);

  const sessionRuns = useMemo(() => {
    const all = sessionId
      ? [...runs.values()].filter((run) => run.sessionId === sessionId as string)
      : [];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }, [runs, sessionId]);

  const running  = sessionRuns.filter((run) => run.status === 'running');
  const terminal = sessionRuns.filter((run) => run.status !== 'running');

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
          {running.map((run, i) => (
            <AgentRunRow key={run.id} run={run} staggerIndex={i} onOpen={() => setDetailId(run.id)} />
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
            {terminal.slice(0, visibleCount).map((run, i) => (
              <AgentRunRow
                key={run.id}
                run={run}
                staggerIndex={running.length + i}
                onOpen={() => setDetailId(run.id)}
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

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-2 pt-0.5 pb-0.5 text-xs font-medium tracking-wider uppercase text-[var(--ema-text-tertiary)]">
      {children}
    </div>
  );
}

// ── 列表行 ────────────────────────────────────────────────────────────────────

function AgentRunRow({
  run, onOpen, staggerIndex = 0,
}: {
  run: AgentRunState;
  onOpen(): void;
  staggerIndex?: number;
}): JSX.Element {
  const { icon, color } = statusMeta(run.status);
  const isRunning = run.status === 'running';

  const title = run.description ?? run.live?.promptExcerpt ?? run.modelId ?? '子智能体';
  const summary = run.live
    ? `轮次 ${run.live.iteration} · 工具 ${run.live.toolCallCount} · ${formatElapsed(run.live.elapsedMs)}`
    : run.error
      ?? run.outputExcerpt
      ?? [
        run.iterations != null ? `${run.iterations} 轮次` : null,
        run.toolCallCount != null ? `${run.toolCallCount} 个工具` : null,
      ].filter(Boolean).join(' · ');
  const at = run.completedAt ?? run.updatedAt;

  return (
    <div
      className="relative rounded-lg overflow-hidden cursor-pointer transition-all flex ema-stagger-in bg-[var(--ema-surface-1)] border border-[var(--ema-border)] hover:border-[var(--ema-border-hover)]"
      style={{ '--stagger-i': staggerIndex } as CSSProperties}
      onClick={onOpen}
    >
      {isRunning && <div className="ema-running-bar" />}
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
        <span className="shrink-0 mt-0.5 text-[10px] tabular-nums text-[var(--ema-text-tertiary)]">
          {formatRelativeTime(at)}
        </span>
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
  const run = useAgentRunStore((s) => s.runs.get(agentRunId));
  const { icon, color } = statusMeta(run?.status ?? 'cancelled');

  return (
    <div className={`flex flex-col min-h-0 h-full ${className}`}>
      {/* 返回 + 标题 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 border-b border-[var(--ema-border)]">
        <Button variant="ghost" size="sm" className="px-1.5 text-[var(--ema-text-tertiary)]" onClick={onBack}>
          <span className="i-lucide:arrow-left text-sm" aria-hidden />
        </Button>
        {run && (
          <>
            <span className={`text-sm shrink-0 ${icon}`} style={{ color }} aria-hidden />
            <span className="text-xs font-medium truncate text-[var(--ema-text-primary)]">
              {run.description ?? run.live?.promptExcerpt ?? '子智能体'}
            </span>
            <Badge variant={STATUS_BADGE_VARIANT[run.status]} dot={run.status === 'running'}>
              {STATUS_LABEL[run.status]}
            </Badge>
          </>
        )}
      </div>

      {run === undefined ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--ema-text-tertiary)]">
          该执行记录不存在或已被清理
        </div>
      ) : (
        <>
          {/* 事实行：模型、轮次、工具、tokens、耗时——全部来自持久记录 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 shrink-0 text-[11px] text-[var(--ema-text-tertiary)] border-b border-[var(--ema-border)]">
            <span>{run.live?.model ?? run.modelId ?? 'subagent'}</span>
            {run.live && (
              <>
                <span>轮次 {run.live.iteration}</span>
                <span>工具 {run.live.toolCallCount}</span>
                <span>{formatElapsed(run.live.elapsedMs)}</span>
              </>
            )}
            {!run.live && run.iterations != null && <span>{run.iterations} 轮次</span>}
            {!run.live && run.toolCallCount != null && <span>{run.toolCallCount} 个工具</span>}
            {run.inputTokens != null && (
              <span>{((run.inputTokens + (run.outputTokens ?? 0)) / 1000).toFixed(1)}k tokens</span>
            )}
            {run.completedAt != null && (
              <span>{formatElapsed(run.completedAt - run.createdAt)}</span>
            )}
          </div>
          {run.error && (
            <p className="px-3 py-1.5 shrink-0 text-xs truncate text-[var(--ema-danger-text)] border-b border-[var(--ema-border)]">
              {run.error}
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
  const messages       = useAgentRunStore((s) => s.transcripts.get(agentRunId));

  useEffect(() => {
    void loadTranscript(agentRunId);
  }, [agentRunId, loadTranscript]);

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
          <TranscriptRow msg={msg} />
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

function TranscriptRow({ msg }: { msg: Pick<AgentRunMessageItem, 'role' | 'content'> }): JSX.Element {
  if (msg.role === 'reasoning') {
    const c = msg.content as AgentRunTextContent;
    return <ReasoningBlock text={c.text} />;
  }

  if (msg.role === 'assistant') {
    const c = msg.content as AgentRunTextContent;
    return (
      <p className="text-xs py-1 whitespace-pre-wrap break-words selectable text-[var(--ema-text-primary)]">
        {c.text}
      </p>
    );
  }

  if (msg.role === 'tool_call') {
    const c = msg.content as AgentRunToolCallContent;
    return (
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="i-lucide:square-code text-sm flex-shrink-0 text-[var(--ema-primary)]" />
        <span className="text-xs font-mono text-[var(--ema-primary)]">{c.name}</span>
      </div>
    );
  }

  if (msg.role === 'tool_result') {
    const c = msg.content as AgentRunToolResultContent;
    const excerpt = toolResultExcerpt(c);
    return (
      <div className="flex items-start gap-1.5 py-0.5">
        <span
          className={`text-sm flex-shrink-0 mt-0.5 ${c.isError ? 'i-lucide:circle-alert' : 'i-lucide:circle-check'} ${c.isError ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-success)]'}`}
        />
        <span className={`text-xs truncate selectable ${c.isError ? 'text-[var(--ema-danger-text)]' : 'text-[var(--ema-text-secondary)]'}`}>
          {excerpt || (c.isError ? '失败' : '完成')}
        </span>
        {c.durationMs !== undefined && (
          <span className="ml-auto text-xs flex-shrink-0 text-[var(--ema-text-tertiary)]">
            {c.durationMs}ms
          </span>
        )}
      </div>
    );
  }

  return <></>;
}

/** 从模型投影内容取一行纯文本摘要；媒体块没有文本时回退空串。 */
function toolResultExcerpt(result: AgentRunToolResultContent): string {
  if (typeof result.content === 'string') return result.content;
  const text = result.content.find((part) => part.type === 'text');
  return text?.text ?? '';
}

const STATUS_LABEL: Record<AgentRunState['status'], string> = {
  running:      '运行中',
  completed:    '已完成',
  failed:       '失败',
  cancelled:    '已取消',
};

const STATUS_BADGE_VARIANT: Record<AgentRunState['status'], BadgeVariant> = {
  running:      'primary',
  completed:    'success',
  failed:       'danger',
  cancelled:    'neutral',
};

type StatusMeta = { icon: string; color: string };

function statusMeta(status: AgentRunState['status']): StatusMeta {
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
