// 在输入框上方居中镜像当前 Turn 的 TODO。
import { useEffect, useState, type JSX } from 'react';
import { TodoWriteActivitySummary, TodoWriteArgsView } from '@ema-agent/builtin-tools/ui';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { useChatWorkspace } from '../../state/chatWorkspace.js';
import { useLiveTurns } from '../../state/liveTurns.js';

export function ChatActivityStrip(): JSX.Element | null {
  const sessionId = useChatWorkspace((state) => state.viewedSessionId);
  const stream = useLiveTurns((state) => (
    sessionId ? state.bySession.get(sessionId) : undefined
  ));
  const [todoOpen, setTodoOpen] = useState(false);

  useEffect(() => {
    setTodoOpen(false);
  }, [sessionId, stream?.turnId]);

  let todoArgs: unknown;
  for (let index = (stream?.items.length ?? 0) - 1; index >= 0; index -= 1) {
    const item = stream?.items[index];
    if (item?.type === 'tool_use' && item.name === BuiltinTools.TodoWrite.name && item.args !== undefined) {
      todoArgs = item.args;
      break;
    }
  }

  if (todoArgs === undefined) return null;

  return (
    <div className="shrink-0 px-4 pt-2">
      <div className="mx-auto max-w-2xl">
        <div
          className="ema-collapsible mb-1.5"
          style={{
            gridTemplateRows: todoOpen ? '1fr' : '0fr',
            opacity: todoOpen ? 1 : 0,
          }}
        >
          <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-2 shadow-[var(--ema-shadow-2)]">
            <TodoWriteArgsView args={todoArgs} />
          </div>
        </div>

        <div className="mx-auto w-1/2">
          <TodoWriteActivitySummary
            args={todoArgs}
            open={todoOpen}
            onToggle={() => setTodoOpen((open) => !open)}
          />
        </div>
      </div>
    </div>
  );
}
