// 展示当前 Session 的子智能体 AgentRun、取消入口与完整执行记录。
import { useState, useEffect, useCallback, useMemo, useRef, type JSX, type CSSProperties } from 'react';
import { Badge, Button, Divider, IconButton, Input, Spinner, type BadgeVariant } from '@ema-agent/ui';
import { useAgentRunStore, type AgentRunState, type AgentRunMessageWire } from '../../stores/agentRunStore.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import type { ToolCallMessageContent, AssistantMessageContent, ReasoningMessageContent, ToolResultMessageContent } from '../../api/agentRuns.js';
import { showToast } from '../../lib/toast.js';

export interface AgentRunPanelProps {
  className?: string;
  /** 深链标签（agentRun:<id>）初始展开的执行；列表标签不传。 */
  initialExpandedId?: string;
}

export function AgentRunPanel({ className = '', initialExpandedId }: AgentRunPanelProps): JSX.Element {
  const sessionId      = useConversationStore((s) => s.viewedSessionId);
  const runs           = useAgentRunStore((s) => s.runs);
  const loadForSession = useAgentRunStore((s) => s.loadForSession);
  const clearTerminal  = useAgentRunStore((s) => s.clearTerminal);

  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);
  const [search,     setSearch]     = useState('');

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId as string);
  }, [sessionId, loadForSession]);

  const sessionRuns = useMemo(() => {
    const all = sessionId
      ? [...runs.values()].filter((run) => run.sessionId === sessionId as string)
      : [];
    const kw = search.trim().toLowerCase();
    return kw
      ? all.filter((run) =>
          run.id.toLowerCase().includes(kw) ||
          (run.purpose ?? run.live?.promptExcerpt ?? '').toLowerCase().includes(kw)
        )
      : all;
  }, [runs, sessionId, search]);

  const running  = sessionRuns.filter((run) => run.status === 'running');
  const terminal = sessionRuns.filter((run) => run.status !== 'running');

  const allForSession = sessionId
    ? [...runs.values()].filter((run) => run.sessionId === sessionId as string)
    : [];
  const stats = {
    total:     allForSession.length,
    running:   allForSession.filter((t) => t.status === 'running').length,
    completed: allForSession.filter((t) => t.status === 'completed').length,
    failed:    allForSession.filter((t) => t.status === 'failed' || t.status === 'cancelled').length,
  };

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      await clearTerminal(sessionId as string);
      setExpandedId((id) => terminal.some((t) => t.id === id) ? null : id);
    } catch (error: unknown) {
      showToast(error instanceof Error ? `清空失败：${error.message}` : '清空失败', { variant: 'danger' });
    }
  }, [sessionId, clearTerminal, terminal]);

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {/* 状态统计 */}
      {stats.total > 0 && (
        <div className="flex gap-4 px-3 py-2 rounded-lg mx-1 mb-0.5 bg-[var(--ema-bg)]"
             style={{ border: '1px solid var(--ema-border)' }}>
          {([
            { label: '总计',   value: stats.total,     color: 'var(--ema-text-secondary)' },
            { label: '运行中', value: stats.running,   color: 'var(--ema-primary)'       },
            { label: '已完成', value: stats.completed, color: 'var(--ema-success)'       },
            { label: '失败',   value: stats.failed,    color: 'var(--ema-danger)'        },
          ] as const).map(({ label, value, color }) => (
            <div key={label} className="flex flex-col items-center flex-1">
              <span className="text-sm font-bold leading-none" style={{ color }}>{value}</span>
              <span className="text-[9px] mt-0.5 text-[var(--ema-text-tertiary)]">{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* 搜索与终态清理 */}
      <div className="flex items-center gap-1.5 px-1 mb-0.5">
        <Input
          inputSize="sm"
          className="flex-1"
          placeholder="搜索子智能体执行…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {terminal.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void handleClear()}>
            清空已完结
          </Button>
        )}
      </div>

      {/* 空状态 */}
      {sessionRuns.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-[var(--ema-text-tertiary)]">
          <span className="i-lucide:bot text-2xl opacity-40" />
          <span>{search ? '无匹配执行' : '暂无子智能体执行'}</span>
        </div>
      )}

      {/* 正在运行的子智能体 */}
      {running.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>运行中</SectionLabel>
          {running.map((t, i) => (
            <AgentRunCard
              key={t.id}
              run={t}
              staggerIndex={i}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((id) => id === t.id ? null : t.id)}
            />
          ))}
        </div>
      )}

      {/* 已结束的执行记录 */}
      {terminal.length > 0 && (
        <div className="flex flex-col gap-1 mt-2">
          <SectionLabel>历史执行</SectionLabel>
          {terminal.map((t, i) => (
            <AgentRunCard
              key={t.id}
              run={t}
              staggerIndex={running.length + i}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((id) => id === t.id ? null : t.id)}
            />
          ))}
        </div>
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

interface AgentRunCardProps {
  run:          AgentRunState;
  expanded:     boolean;
  onToggle:     () => void;
  staggerIndex?: number;
}

function AgentRunCard({ run, expanded, onToggle, staggerIndex = 0 }: AgentRunCardProps): JSX.Element {
  const deleteRun = useAgentRunStore((s) => s.deleteRun);
  const { icon, color } = statusMeta(run.status);
  const isRunning = run.status === 'running';

  const excerpt = run.live?.promptExcerpt
    ?? run.purpose
    ?? undefined;

  const handleDelete = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteRun(run.id, run.parentTurnId);
    } catch (error: unknown) {
      showToast(
        error instanceof Error ? `取消或删除失败：${error.message}` : '取消或删除失败',
        { variant: 'danger' },
      );
    }
  }, [deleteRun, run.id, run.parentTurnId]);

  const barColor = {
    running:      'var(--ema-primary)',
    completed:    'var(--ema-success)',
    failed:       'var(--ema-danger)',
    cancelled:    'var(--ema-text-tertiary)',
  }[run.status];

  return (
    <div
      className="relative rounded-lg overflow-hidden cursor-pointer transition-all flex ema-stagger-in bg-[var(--ema-surface-1)] ema-card-decorate ema-card-decorate--starfield"
      style={{
        border:        `1px solid ${expanded ? 'var(--ema-border-hover)' : 'var(--ema-border)'}`,
        '--stagger-i': staggerIndex,
      } as CSSProperties}
      onClick={onToggle}
    >
      {/* 左侧状态条沿用现有卡片视觉语言 */}
      <div className="w-1 shrink-0 my-1 ml-0.5 mr-1 rounded-full"
           style={{ background: barColor, opacity: isRunning ? undefined : 0.7 }} />

      {/* 运行中的顶部脉冲 */}
      {isRunning && <div className="ema-running-bar" />}

      {/* 执行摘要 */}
      <div className="flex items-start gap-2 px-2 py-2 flex-1 min-w-0">
        {/* 状态图标 */}
        <span className={`mt-0.5 text-base flex-shrink-0 ${icon}`} style={{ color }} />

        {/* 模型、目的与统计 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs truncate text-[var(--ema-text-secondary)]">
              {run.live?.model ?? run.modelId ?? 'subagent'}
            </span>
            <Badge variant={STATUS_BADGE_VARIANT[run.status]} dot={isRunning}>
              {STATUS_LABEL[run.status]}
            </Badge>
          </div>
          {excerpt && (
            <p className="text-xs mt-0.5 line-clamp-2 text-[var(--ema-text-primary)]">
              {excerpt}
            </p>
          )}
          {run.error && (
            <p className="text-xs mt-0.5 truncate text-[var(--ema-danger-text)]">
              {run.error}
            </p>
          )}

          {/* 当前进度 */}
          {run.live && (
            <div className="flex items-center gap-3 mt-1 text-xs text-[var(--ema-text-tertiary)]">
              <span>轮次 {run.live.iteration}</span>
              <span>工具 {run.live.toolCallCount}</span>
              <span>{formatElapsed(run.live.elapsedMs)}</span>
            </div>
          )}

          {/* 终态统计 */}
          {!run.live && run.iterations != null && (
            <div className="flex items-center gap-3 mt-1 text-xs text-[var(--ema-text-tertiary)]">
              <span>{run.iterations} 轮次</span>
              {run.toolCallCount != null && <span>{run.toolCallCount} 个工具</span>}
              {run.inputTokens != null && (
                <span>{((run.inputTokens + (run.outputTokens ?? 0)) / 1000).toFixed(1)}k tokens</span>
              )}
            </div>
          )}
        </div>

        <IconButton
          variant="danger"
          size="sm"
          icon={isRunning ? 'i-lucide:circle-stop' : 'i-lucide:trash-2'}
          label={isRunning ? '取消' : '删除'}
          onClick={handleDelete}
        />
      </div>

      {/* 展开后再读取执行记录 */}
      {expanded && <AgentRunTranscript agentRunId={run.id} />}
    </div>
  );
}

function AgentRunTranscript({ agentRunId }: { agentRunId: string }): JSX.Element {
  const loadTranscript = useAgentRunStore((s) => s.loadTranscript);
  const messages       = useAgentRunStore((s) => s.transcripts.get(agentRunId));

  useEffect(() => {
    void loadTranscript(agentRunId);
  }, [agentRunId, loadTranscript]);

  const divider = (
    <Divider className="w-auto mx-3" />
  );

  if (messages === null || messages === undefined) {
    return (
      <>
        {divider}
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      </>
    );
  }

  if (messages.length === 0) {
    return (
      <>
        {divider}
        <div className="py-3 px-3 text-xs text-center text-[var(--ema-text-tertiary)]">
          无对话记录
        </div>
      </>
    );
  }

  return (
    <>
      {divider}
      <div
        className="flex flex-col gap-0.5 px-3 py-2 max-h-64 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {messages.map((msg) => (
          <div key={msg.id} className="ema-timeline-row">
            <TranscriptRow msg={msg} />
          </div>
        ))}
      </div>
    </>
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

function TranscriptRow({ msg }: { msg: AgentRunMessageWire }): JSX.Element {
  if (msg.role === 'reasoning') {
    const c = msg.content as ReasoningMessageContent;
    return <ReasoningBlock text={c.text} />;
  }

  if (msg.role === 'assistant') {
    const c = msg.content as AssistantMessageContent;
    return (
      <p className="text-xs py-1 whitespace-pre-wrap break-words selectable text-[var(--ema-text-primary)]">
        {c.text}
      </p>
    );
  }

  if (msg.role === 'tool_call') {
    const c = msg.content as ToolCallMessageContent;
    return (
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="i-lucide:square-code text-sm flex-shrink-0 text-[var(--ema-primary)]" />
        <span className="text-xs font-mono text-[var(--ema-primary)]">{c.name}</span>
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          轮次 {c.iteration}
        </span>
      </div>
    );
  }

  if (msg.role === 'tool_result') {
    const c = msg.content as ToolResultMessageContent;
    return (
      <div className="flex items-start gap-1.5 py-0.5">
        <span
          className={`text-sm flex-shrink-0 mt-0.5 ${c.isError ? 'i-lucide:circle-alert' : 'i-lucide:circle-check'} ${c.isError ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-success)]'}`}
        />
        <span className={`text-xs truncate selectable ${c.isError ? 'text-[var(--ema-danger-text)]' : 'text-[var(--ema-text-secondary)]'}`}>
          {c.excerpt || (c.isError ? c.error ?? '失败' : '完成')}
        </span>
        <span className="ml-auto text-xs flex-shrink-0 text-[var(--ema-text-tertiary)]">
          {c.durationMs}ms
        </span>
      </div>
    );
  }

  return <></>;
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
