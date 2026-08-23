// TodoWriteTool 的桌面展示。清单事实来自 tool_use input，结果文本只确认更新成功。
import type { JSX } from 'react';
import type { TodoItem } from './TodoWriteTool.js';

interface TodoWriteViewInput {
  todos: TodoItem[];
}

export function TodoWriteArgsView({ args }: { args: unknown }): JSX.Element | null {
  const input = asTodoWriteInput(args);
  if (!input) return null;

  const completed = input.todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="flex flex-col gap-2 pr-6">
      <div className="flex items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
        <span className="i-lucide:list-checks text-sm text-[var(--ema-primary)]" aria-hidden />
        <span>执行清单 {completed}/{input.todos.length}</span>
      </div>
      {input.todos.length === 0 ? (
        <p className="text-[11px] italic text-[var(--ema-text-tertiary)]">当前清单已清空</p>
      ) : (
        <div className="flex flex-col gap-1">
          {input.todos.map((todo, index) => (
            <TodoRow key={`${index}:${todo.content}`} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 输入框上方的折叠摘要；完整清单仍复用 TodoWriteArgsView。 */
export function TodoWriteActivitySummary({
  args,
  open,
  onToggle,
}: {
  args: unknown;
  open: boolean;
  onToggle(): void;
}): JSX.Element | null {
  const input = asTodoWriteInput(args);
  if (!input) return null;

  const completed = input.todos.filter((todo) => todo.status === 'completed').length;
  const current = input.todos.find((todo) => todo.status === 'in_progress')
    ?? input.todos.find((todo) => todo.status === 'pending');

  return (
    <button
      type="button"
      className="ema-press flex h-8 w-full items-center gap-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 text-xs shadow-[var(--ema-shadow-1)]"
      onClick={onToggle}
      aria-expanded={open}
    >
      <span className="i-lucide:list-checks shrink-0 text-sm text-[var(--ema-primary)]" aria-hidden />
      <span className="shrink-0 text-[var(--ema-text-secondary)]">
        清单 {completed}/{input.todos.length}
      </span>
      {current && (
        <span className="min-w-0 flex-1 truncate text-left text-[var(--ema-text-tertiary)]">
          {current.status === 'in_progress' ? current.activeForm : current.content}
        </span>
      )}
      <span
        className="i-lucide:chevron-up ml-auto shrink-0 text-xs text-[var(--ema-text-tertiary)] transition-transform duration-[var(--ema-duration-base)]"
        style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        aria-hidden
      />
    </button>
  );
}

function TodoRow({ todo }: { todo: TodoItem }): JSX.Element {
  const completed = todo.status === 'completed';
  const active = todo.status === 'in_progress';
  const icon = completed
    ? 'i-lucide:circle-check text-[var(--ema-success)]'
    : active
      ? 'i-lucide:loader-circle animate-spin text-[var(--ema-primary)]'
      : 'i-lucide:circle text-[var(--ema-text-tertiary)]';
  const label = active ? todo.activeForm : todo.content;

  return (
    <div className="flex items-start gap-2 rounded-md px-1.5 py-1 text-xs">
      <span className={`${icon} mt-0.5 shrink-0 text-sm`} aria-hidden />
      <span className={completed
        ? 'text-[var(--ema-text-tertiary)] line-through'
        : active
          ? 'font-medium text-[var(--ema-text-primary)]'
          : 'text-[var(--ema-text-secondary)]'}
      >
        {label}
      </span>
    </div>
  );
}

function asTodoWriteInput(value: unknown): TodoWriteViewInput | null {
  if (!isRecord(value) || !Array.isArray(value['todos'])) return null;
  const todos: TodoItem[] = [];
  for (const item of value['todos']) {
    if (!isRecord(item)) return null;
    if (typeof item['content'] !== 'string' || typeof item['activeForm'] !== 'string') return null;
    const status = item['status'];
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
    todos.push({ content: item['content'], activeForm: item['activeForm'], status });
  }
  return { todos };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
