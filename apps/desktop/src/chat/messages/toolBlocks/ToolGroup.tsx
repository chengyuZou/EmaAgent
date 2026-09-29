// 单个普通 Tool 直接显示调用卡片, 多个连续 Tool 才折叠成一行摘要.

import { memo, useState, type JSX } from 'react';
import { ToolCallBlock } from './ToolCallBlock.js';
import { useMessageExpansion } from '../messageExpansion.js';
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
  sectionKey,
}: {
  readonly calls: readonly ToolDisplayCall[];
  readonly streaming: boolean;
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly sectionKey: string;
}): JSX.Element {
  const [open, setOpen] = useMessageExpansion(sectionKey);
  const [hasOpened, setHasOpened] = useState(open);

  // 流式期间调用数量会增长, Hook 必须在单个调用的提前返回之前执行.
  if (calls.length === 1) {
    const call = calls[0]!;
    return (
      <ToolCallBlock
        key={toolCallId(call)}
        call={call}
        streaming={streaming}
        turnId={turnId}
        sessionId={sessionId}
      />
    );
  }

  const tally = tallyTools(calls);
  const summary = toolGroupSummary(tally);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex items-center gap-1.5 py-0.5 text-left text-xs select-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)] transition-colors"
        onClick={() => {
          setHasOpened(true);
          setOpen(value => !value);
        }}
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
        <div className="flex flex-col">
          {/* 首次展开才挂载明细, 随后保持挂载, 让 CSS 完成收起动画并保留调用卡片状态. */}
          {hasOpened && calls.map(call => (
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
