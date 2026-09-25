// 把连续普通 Tool 折叠成一行摘要, 只有用户展开时才挂载组内调用明细.

import { memo, useState, type JSX } from 'react';
import { ToolCallBlock } from './ToolCallBlock.js';
import {
  tallyTools,
  toolCallId,
  toolGroupSummary,
  type ToolDisplayCall,
} from './toolGroups.js';

export const ToolGroup = memo(function ToolGroup({
  calls,
  streaming,
  turnId,
  sessionId,
}: {
  readonly calls: readonly ToolDisplayCall[];
  readonly streaming: boolean;
  readonly turnId?: string;
  readonly sessionId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const tally = tallyTools(calls);
  const summary = toolGroupSummary(calls, tally);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex items-center gap-1.5 py-0.5 text-left text-xs select-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)] transition-colors"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="i-lucide:wrench text-[11px] shrink-0" aria-hidden />
        <span className="truncate">{summary.join(' · ') || `${calls.length} 个工具`}</span>
        {tally.errors > 0 && (
          <span className="shrink-0 text-[var(--ema-danger-text)]">· {tally.errors} 个错误</span>
        )}
        <span
          className="i-lucide:chevron-down ml-auto text-[10px] shrink-0 transition-transform duration-[var(--ema-duration-fast)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </button>

      <div
        className="ema-collapsible ema-chat-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        {/* 子行进 12+12 竖轨, 与 ToolCallBlock 展开体/思考块同一分组语汇。 */}
        <div className="ml-3 flex flex-col gap-0.5 border-l border-[var(--ema-border)] pt-0.5 pl-3">
          {open && calls.map(call => (
            <ToolCallBlock
              key={toolCallId(call)}
              call={call}
              streaming={streaming}
              turnId={turnId}
              sessionId={sessionId}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
