/**
 * TaskPanel — agent task list for the current session.
 *
 * Shows running tasks first, then terminal (completed/failed/cancelled).
 * Expanding a card loads and shows the subagent transcript.
 */
import { useState, useEffect, useCallback, useMemo, useRef, type JSX, type CSSProperties } from 'react';
import { Badge, Button, IconButton, Input, Spinner, type BadgeVariant } from '@ema-agent/ui';
import { useAgentTaskStore, type AgentTaskState, type AgentTaskMessageWire } from '../stores/agent-task-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import type { ToolCallMessageContent, AssistantMessageContent, ReasoningMessageContent, ToolResultMessageContent } from '../api/agent-tasks.js';

// ── TaskPanel ─────────────────────────────────────────────────────────────────

export interface TaskPanelProps {
  className?: string;
}

export function TaskPanel({ className = '' }: TaskPanelProps): JSX.Element {
  const sessionId      = useConversationStore((s) => s.viewedSessionId);
  const tasks          = useAgentTaskStore((s) => s.tasks);
  const loadForSession = useAgentTaskStore((s) => s.loadForSession);
  const clearTerminal  = useAgentTaskStore((s) => s.clearTerminal);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search,     setSearch]     = useState('');

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId as string);
  }, [sessionId, loadForSession]);

  const sessionTasks = useMemo(() => {
    const all = sessionId
      ? [...tasks.values()].filter((t) => t.sessionId === sessionId as string)
      : [];
    const kw = search.trim().toLowerCase();
    return kw
      ? all.filter((t) =>
          t.id.toLowerCase().includes(kw) ||
          (t.description ?? t.live?.promptExcerpt ?? '').toLowerCase().includes(kw)
        )
      : all;
  }, [tasks, sessionId, search]);

  const running  = sessionTasks.filter((t) => t.status === 'running' || t.status === 'waiting_user');
  const terminal = sessionTasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled');

  const allForSession = sessionId
    ? [...tasks.values()].filter((t) => t.sessionId === sessionId as string)
    : [];
  const stats = {
    total:     allForSession.length,
    running:   allForSession.filter((t) => t.status === 'running' || t.status === 'waiting_user').length,
    completed: allForSession.filter((t) => t.status === 'completed').length,
    failed:    allForSession.filter((t) => t.status === 'failed' || t.status === 'cancelled').length,
  };

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    await clearTerminal(sessionId as string);
    setExpandedId((id) => terminal.some((t) => t.id === id) ? null : id);
  }, [sessionId, clearTerminal, terminal]);

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {/* Stats row */}
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

      {/* Search + clear */}
      <div className="flex items-center gap-1.5 px-1 mb-0.5">
        <Input
          inputSize="sm"
          className="flex-1"
          placeholder="搜索任务…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {terminal.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void handleClear()}>
            清空已完结
          </Button>
        )}
      </div>

      {/* Empty state */}
      {sessionTasks.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-[var(--ema-text-tertiary)]">
          <span className="i-lucide:bot text-2xl opacity-40" />
          <span>{search ? '无匹配任务' : '暂无 Agent 任务'}</span>
        </div>
      )}

      {/* Running tasks */}
      {running.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>运行中</SectionLabel>
          {running.map((t, i) => (
            <TaskCard
              key={t.id}
              task={t}
              staggerIndex={i}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((id) => id === t.id ? null : t.id)}
            />
          ))}
        </div>
      )}

      {/* Terminal tasks */}
      {terminal.length > 0 && (
        <div className="flex flex-col gap-1 mt-2">
          <SectionLabel>历史任务</SectionLabel>
          {terminal.map((t, i) => (
            <TaskCard
              key={t.id}
              task={t}
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

// ── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-2 pt-0.5 pb-0.5 text-xs font-medium tracking-wider uppercase text-[var(--ema-text-tertiary)]">
      {children}
    </div>
  );
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task:         AgentTaskState;
  expanded:     boolean;
  onToggle:     () => void;
  staggerIndex?: number;
}

function TaskCard({ task, expanded, onToggle, staggerIndex = 0 }: TaskCardProps): JSX.Element {
  const deleteTask = useAgentTaskStore((s) => s.deleteTask);
  const { icon, color } = statusMeta(task.status);
  const isRunning = task.status === 'running' || task.status === 'waiting_user';

  const excerpt = task.live?.promptExcerpt
    ?? task.description
    ?? (task.status === 'waiting_user' ? '等待用户确认…' : undefined);

  const handleDelete = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteTask(task.id, task.parentTurnId);
  }, [deleteTask, task.id, task.parentTurnId]);

  const barColor = {
    running:      'var(--ema-primary)',
    waiting_user: 'var(--ema-warning)',
    completed:    'var(--ema-success)',
    failed:       'var(--ema-danger)',
    cancelled:    'var(--ema-text-tertiary)',
  }[task.status];

  return (
    <div
      className="relative rounded-lg overflow-hidden cursor-pointer transition-all flex ema-stagger-in bg-[var(--ema-surface-1)]"
      style={{
        border:        `1px solid ${expanded ? 'var(--ema-border-hover)' : 'var(--ema-border)'}`,
        '--stagger-i': staggerIndex,
      } as CSSProperties}
      onClick={onToggle}
    >
      {/* Left status bar (Apix style) */}
      <div className="w-1 shrink-0 my-1 ml-0.5 mr-1 rounded-full"
           style={{ background: barColor, opacity: isRunning ? undefined : 0.7 }} />

      {/* Running pulse bar (top) */}
      {isRunning && <div className="ema-running-bar" />}

      {/* Card header */}
      <div className="flex items-start gap-2 px-2 py-2 flex-1 min-w-0">
        {/* Status icon */}
        <span className={`mt-0.5 text-base flex-shrink-0 ${icon}`} style={{ color }} />

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs truncate text-[var(--ema-text-secondary)]">
              {task.live?.model ?? 'subagent'}
            </span>
            <Badge variant={STATUS_BADGE_VARIANT[task.status]} dot={isRunning}>
              {STATUS_LABEL[task.status]}
            </Badge>
          </div>
          {excerpt && (
            <p className="text-xs mt-0.5 line-clamp-2 text-[var(--ema-text-primary)]">
              {excerpt}
            </p>
          )}
          {task.error && (
            <p className="text-xs mt-0.5 truncate text-[var(--ema-danger-text)]">
              {task.error}
            </p>
          )}

          {/* Live progress row */}
          {task.live && (
            <div className="flex items-center gap-3 mt-1 text-xs text-[var(--ema-text-tertiary)]">
              <span>轮次 {task.live.iteration}</span>
              <span>工具 {task.live.toolCallCount}</span>
              <span>{formatElapsed(task.live.elapsedMs)}</span>
            </div>
          )}

          {/* Terminal stats */}
          {!task.live && task.iterations != null && (
            <div className="flex items-center gap-3 mt-1 text-xs text-[var(--ema-text-tertiary)]">
              <span>{task.iterations} 轮次</span>
              {task.inputTokens != null && (
                <span>{((task.inputTokens + (task.outputTokens ?? 0)) / 1000).toFixed(1)}k tokens</span>
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

      {/* Transcript (lazy loaded) */}
      {expanded && <TaskTranscript taskId={task.id} />}
    </div>
  );
}

// ── TaskTranscript ────────────────────────────────────────────────────────────

function TaskTranscript({ taskId }: { taskId: string }): JSX.Element {
  const loadTranscript = useAgentTaskStore((s) => s.loadTranscript);
  const messages       = useAgentTaskStore((s) => s.transcripts.get(taskId));

  useEffect(() => {
    void loadTranscript(taskId);
  }, [taskId, loadTranscript]);

  const divider = (
    <div className="bg-[var(--ema-border)]" style={{ height: 1, margin: '0 12px' }} />
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

// ── TranscriptRow ─────────────────────────────────────────────────────────────

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

function TranscriptRow({ msg }: { msg: AgentTaskMessageWire }): JSX.Element {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<AgentTaskState['status'], string> = {
  running:      '运行中',
  waiting_user: '等待确认',
  completed:    '已完成',
  failed:       '失败',
  cancelled:    '已取消',
};

const STATUS_BADGE_VARIANT: Record<AgentTaskState['status'], BadgeVariant> = {
  running:      'primary',
  waiting_user: 'warn',
  completed:    'success',
  failed:       'danger',
  cancelled:    'neutral',
};

type StatusMeta = { icon: string; color: string };

function statusMeta(status: AgentTaskState['status']): StatusMeta {
  switch (status) {
    case 'running':      return { icon: 'i-lucide:loader-circle animate-spin', color: 'var(--ema-primary)' };
    case 'waiting_user': return { icon: 'i-lucide:circle-question-mark',  color: 'var(--ema-warning)' };
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
