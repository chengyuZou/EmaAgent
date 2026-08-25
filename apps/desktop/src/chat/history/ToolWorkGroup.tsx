// 连续工具调用的合并摘要行:动词计数 + 错误染红,展开为逐条 ToolCallBlock。
import { useEffect, useState, type JSX } from 'react';
import type { AssistantSlice } from '../../stores/conversation-store.js';
import { ToolCallBlock } from '../messages/ToolCallBlock.js';
import { tallySummary, tallyTools } from './workGroups.js';

type ToolUseSlice = Extract<AssistantSlice, { type: 'tool_use' }>;

export function ToolWorkGroup({
  slices, streaming, turnId,
}: {
  slices: readonly AssistantSlice[];
  streaming: boolean;
  turnId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(streaming);

  // 流式期间展开直播,终态收起为摘要行。
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  // groupSlices 保证组内全是 tool_use;守卫收窄而不是断言。
  const toolSlices = slices.filter((s): s is ToolUseSlice => s.type === 'tool_use');
  const tally = tallyTools(toolSlices);
  const parts = tallySummary(toolSlices, tally);

  return (
    <div className="flex flex-col">
      <button
        className="flex items-center gap-1.5 py-0.5 text-left text-xs select-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)] transition-colors"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="i-lucide:wrench text-[11px] shrink-0" aria-hidden />
        <span className="truncate">{parts.join(' · ')}</span>
        {tally.errors > 0 && (
          <span className="shrink-0 text-[var(--ema-danger-text)]">· {tally.errors} 个错误</span>
        )}
        <span
          className="i-lucide:chevron-down ml-auto text-[10px] shrink-0 transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="flex flex-col gap-0.5 pt-0.5">
          {toolSlices.map((slice, index) => (
            <ToolCallBlock key={index} slice={slice} streaming={streaming} turnId={turnId} />
          ))}
        </div>
      </div>
    </div>
  );
}
