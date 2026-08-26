// 在输入框上方镜像当前 Turn 的 TODO，并保留最近 Turn 的文件变更入口。
import { useEffect, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import { TodoWriteActivitySummary, TodoWriteArgsView } from '@ema-agent/builtin-tools/ui';
import { BuiltinTools } from '@ema-agent/tools';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useLatestTurnDiffs } from '../review/reviewDiffs.js';

/** 清单行只显示文件名; 完整路径进 tooltip。 */
function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function ChatActivityStrip({
  onOpenReview,
}: {
  onOpenReview(): void;
}): JSX.Element | null {
  const sessionId = useConversationStore((state) => state.viewedSessionId);
  const streaming = useConversationStore((state) => (
    sessionId ? state.streamingMap.get(sessionId as string) : undefined
  ));
  const diffs = useLatestTurnDiffs(sessionId as string | null);
  const [todoOpen, setTodoOpen] = useState(false);
  const [diffsOpen, setDiffsOpen] = useState(false);

  useEffect(() => {
    setTodoOpen(false);
    setDiffsOpen(false);
  }, [sessionId, streaming?.turnId]);

  let todoArgs: unknown;
  for (let index = (streaming?.slices.length ?? 0) - 1; index >= 0; index -= 1) {
    const slice = streaming?.slices[index];
    if (slice?.type === 'tool_use' && slice.name === BuiltinTools.TodoWrite.name && slice.args !== undefined) {
      todoArgs = slice.args;
      break;
    }
  }

  const hasTodo = todoArgs !== undefined;
  const hasDiffs = diffs.length > 0;
  if (!hasTodo && !hasDiffs) return null;

  const layout = hasTodo && hasDiffs ? 'both' : hasTodo ? 'todo-only' : 'diff-only';
  const additions = diffs.reduce((total, diff) => total + diff.additions, 0);
  const deletions = diffs.reduce((total, diff) => total + diff.deletions, 0);

  return (
    <div className="shrink-0 px-4 pt-2">
      <div className="mx-auto max-w-2xl">
        {hasTodo && (
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
        )}

        {/* 图 1 组: 最近 Turn 的文件变更清单;行点击打开整页 Review(git 工作区视图) */}
        {hasDiffs && (
          <div
            className="ema-collapsible mb-1.5"
            style={{
              gridTemplateRows: diffsOpen ? '1fr' : '0fr',
              opacity: diffsOpen ? 1 : 0,
            }}
          >
            <div>
              <div className="rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] py-1 shadow-[var(--ema-shadow-1)]">
                {diffs.map((diff) => (
                  <button
                    key={diff.callId}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--ema-surface-2)]"
                    title={diff.filePath}
                    onClick={() => {
                      setDiffsOpen(false);
                      onOpenReview();
                    }}
                  >
                    <span className="i-lucide:link shrink-0 text-xs text-[var(--ema-text-tertiary)]" aria-hidden />
                    <span className="shrink-0 text-xs text-[var(--ema-text-tertiary)]">
                      {diff.status === 'created' ? '新建' : '已编辑'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ema-text-secondary)] underline decoration-[var(--ema-text-tertiary)] underline-offset-2">
                      {baseName(diff.filePath)}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--ema-success-text)]">+{diff.additions}</span>
                    <span className="shrink-0 text-[11px] text-[var(--ema-danger-text)]">-{diff.deletions}</span>
                    <span className="i-lucide:chevron-right shrink-0 text-xs text-[var(--ema-text-tertiary)]" aria-hidden />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="ema-activity-strip-track" data-layout={layout}>
          <div
            className="ema-activity-strip-slot ema-activity-strip-slot--todo"
            data-visible={hasTodo}
            aria-hidden={!hasTodo}
          >
            {hasTodo && (
              <TodoWriteActivitySummary
                args={todoArgs}
                open={todoOpen}
                onToggle={() => setTodoOpen((open) => !open)}
              />
            )}
          </div>

          <div
            className="ema-activity-strip-slot ema-activity-strip-slot--diff"
            data-visible={hasDiffs}
            aria-hidden={!hasDiffs}
          >
            <Button
              variant="ghost"
              className="ema-press flex h-8 w-full items-center gap-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 text-xs shadow-[var(--ema-shadow-1)]"
              onClick={() => setDiffsOpen((open) => !open)}
              disabled={!hasDiffs}
              aria-expanded={diffsOpen}
            >
              <span className="i-lucide:file-diff shrink-0 text-sm text-[var(--ema-info)]" aria-hidden />
              <span className="truncate text-[var(--ema-text-secondary)]">
                {diffs.length} 项变更
              </span>
              <span className="ml-auto text-[var(--ema-success-text)]">+{additions}</span>
              <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
              <span
                className="i-lucide:chevron-up shrink-0 text-xs text-[var(--ema-text-tertiary)] transition-transform duration-[var(--ema-duration-base)]"
                style={{ transform: diffsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                aria-hidden
              />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
