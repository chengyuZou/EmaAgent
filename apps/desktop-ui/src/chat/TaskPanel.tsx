/**
 * TaskPanel — agent task list for the current session.
 *
 * Shows running tasks first, then terminal (completed/failed/cancelled).
 * Expanding a card loads and shows the subagent transcript.
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { useAgentTaskStore, type AgentTaskState, type AgentTaskMessageWire } from '../stores/agent-task-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import type { ToolCallMessageContent, AssistantMessageContent, ToolResultMessageContent } from '../api/agent-tasks.js';

// ── TaskPanel ─────────────────────────────────────────────────────────────────

export interface TaskPanelProps {
  className?: string;
}

export function TaskPanel({ className = '' }: TaskPanelProps): JSX.Element {
  const sessionId     = useConversationStore((s) => s.viewedSessionId);
  const tasks         = useAgentTaskStore((s) => s.tasks);
  const loadForSession = useAgentTaskStore((s) => s.loadForSession);
  const clearTerminal  = useAgentTaskStore((s) => s.clearTerminal);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId as string);
  }, [sessionId, loadForSession]);

  const sessionTasks = sessionId
    ? [...tasks.values()].filter((t) => t.sessionId === sessionId as string)
    : [];

  const running  = sessionTasks.filter((t) => t.status === 'running' || t.status === 'waiting_user');
  const terminal = sessionTasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled');

  const hasTerminal = terminal.length > 0;

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    await clearTerminal(sessionId as string);
    setExpandedId((id) => terminal.some((t) => t.id === id) ? null : id);
  }, [sessionId, clearTerminal, terminal]);

  if (sessionTasks.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 py-10 text-xs ${className}`}
           style={{ color: 'var(--ema-text-tertiary)' }}>
        <span className="i-mdi:robot-outline text-2xl opacity-40" />
        <span>暂无 Agent 任务</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {/* Header actions */}
      {hasTerminal && (
        <div className="flex justify-end px-2 pb-1">
          <button
            onClick={() => void handleClear()}
            className="text-xs px-2 py-0.5 rounded transition-colors"
            style={{
              color:           'var(--ema-text-tertiary)',
              background:      'transparent',
              border:          '1px solid var(--ema-border)',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--ema-text-secondary)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--ema-text-tertiary)'; }}
          >
            清空已完结
          </button>
        </div>
      )}

      {/* Running tasks */}
      {running.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>运行中</SectionLabel>
          {running.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
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
          {terminal.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
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
    <div className="px-2 pt-0.5 pb-0.5 text-xs font-medium tracking-wider uppercase"
         style={{ color: 'var(--ema-text-tertiary)' }}>
      {children}
    </div>
  );
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task:     AgentTaskState;
  expanded: boolean;
  onToggle: () => void;
}

function TaskCard({ task, expanded, onToggle }: TaskCardProps): JSX.Element {
  const deleteTask = useAgentTaskStore((s) => s.deleteTask);
  const { icon, color } = statusMeta(task.status);
  const isRunning = task.status === 'running' || task.status === 'waiting_user';

  const excerpt = task.live?.promptExcerpt
    ?? (task.status === 'waiting_user' ? '等待用户确认…' : undefined);

  const handleDelete = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteTask(task.id, task.parentTurnId);
  }, [deleteTask, task.id, task.parentTurnId]);

  return (
    <div
      className="relative rounded-lg overflow-hidden cursor-pointer transition-all"
      style={{
        background:  'var(--ema-surface-1)',
        border:      `1px solid ${expanded ? 'var(--ema-border-hover)' : 'var(--ema-border)'}`,
      }}
      onClick={onToggle}
    >
      {/* Running pulse bar */}
      {isRunning && <div className="ema-running-bar" />}

      {/* Card header */}
      <div className="flex items-start gap-2 px-3 py-2">
        {/* Status icon */}
        <span className={`mt-0.5 text-base flex-shrink-0 ${icon}`} style={{ color }} />

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="text-xs truncate" style={{ color: 'var(--ema-text-secondary)' }}>
              {task.live?.model ?? 'subagent'}
            </span>
            {task.status === 'waiting_user' && (
              <span className="text-xs px-1 rounded" style={{ background: 'var(--ema-warning-muted)', color: 'var(--ema-warning-text)' }}>
                等待
              </span>
            )}
          </div>
          {excerpt && (
            <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--ema-text-primary)' }}>
              {excerpt}
            </p>
          )}
          {task.error && (
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--ema-danger-text)' }}>
              {task.error}
            </p>
          )}

          {/* Live progress row */}
          {task.live && (
            <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
              <span>轮次 {task.live.iteration}</span>
              <span>工具 {task.live.toolCallCount}</span>
              <span>{formatElapsed(task.live.elapsedMs)}</span>
            </div>
          )}

          {/* Terminal stats */}
          {!task.live && task.iterations != null && (
            <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
              <span>{task.iterations} 轮次</span>
              {task.inputTokens != null && (
                <span>{((task.inputTokens + (task.outputTokens ?? 0)) / 1000).toFixed(1)}k tokens</span>
              )}
            </div>
          )}
        </div>

        {/* Action button */}
        <button
          className="flex-shrink-0 text-base rounded p-0.5 transition-colors"
          style={{ color: 'var(--ema-text-tertiary)', background: 'transparent', border: 'none' }}
          title={isRunning ? '取消' : '删除'}
          onClick={handleDelete}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--ema-danger)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--ema-text-tertiary)'; }}
        >
          <span className={isRunning ? 'i-mdi:stop-circle-outline' : 'i-mdi:trash-can-outline'} />
        </button>
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
    <div style={{ height: 1, background: 'var(--ema-border)', margin: '0 12px' }} />
  );

  if (messages === null || messages === undefined) {
    return (
      <>
        {divider}
        <div className="flex justify-center py-4">
          <span className="i-mdi:loading text-lg animate-spin" style={{ color: 'var(--ema-text-tertiary)' }} />
        </div>
      </>
    );
  }

  if (messages.length === 0) {
    return (
      <>
        {divider}
        <div className="py-3 px-3 text-xs text-center" style={{ color: 'var(--ema-text-tertiary)' }}>
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
          <TranscriptRow key={msg.id} msg={msg} />
        ))}
      </div>
    </>
  );
}

// ── TranscriptRow ─────────────────────────────────────────────────────────────

function TranscriptRow({ msg }: { msg: AgentTaskMessageWire }): JSX.Element {
  if (msg.role === 'assistant') {
    const c = msg.content as AssistantMessageContent;
    return (
      <p className="text-xs py-1 whitespace-pre-wrap break-words selectable"
         style={{ color: 'var(--ema-text-primary)' }}>
        {c.text}
      </p>
    );
  }

  if (msg.role === 'tool_call') {
    const c = msg.content as ToolCallMessageContent;
    return (
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="i-mdi:function-variant text-sm flex-shrink-0"
              style={{ color: 'var(--ema-primary)' }} />
        <span className="text-xs font-mono" style={{ color: 'var(--ema-primary)' }}>{c.name}</span>
        <span className="text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
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
          className={`text-sm flex-shrink-0 mt-0.5 ${c.isError ? 'i-mdi:alert-circle-outline' : 'i-mdi:check-circle-outline'}`}
          style={{ color: c.isError ? 'var(--ema-danger)' : 'var(--ema-success)' }}
        />
        <span className="text-xs truncate selectable"
              style={{ color: c.isError ? 'var(--ema-danger-text)' : 'var(--ema-text-secondary)' }}>
          {c.excerpt || (c.isError ? c.error ?? '失败' : '完成')}
        </span>
        <span className="ml-auto text-xs flex-shrink-0"
              style={{ color: 'var(--ema-text-tertiary)' }}>
          {c.durationMs}ms
        </span>
      </div>
    );
  }

  return <></>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type StatusMeta = { icon: string; color: string };

function statusMeta(status: AgentTaskState['status']): StatusMeta {
  switch (status) {
    case 'running':      return { icon: 'i-mdi:loading animate-spin', color: 'var(--ema-primary)' };
    case 'waiting_user': return { icon: 'i-mdi:help-circle-outline',  color: 'var(--ema-warning)' };
    case 'completed':    return { icon: 'i-mdi:check-circle-outline', color: 'var(--ema-success)' };
    case 'failed':       return { icon: 'i-mdi:alert-circle-outline', color: 'var(--ema-danger)' };
    case 'cancelled':    return { icon: 'i-mdi:cancel',               color: 'var(--ema-text-tertiary)' };
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}
