// 用同一个渲染身份承接 Assistant Message 的流式阶段与持久 History 阶段.

import { memo, useMemo, type JSX } from 'react';
import type { SessionMessage } from '@ema-agent/session';
import type { ToolResult } from '@ema-agent/tools';
import {
  isStreamingMessage,
  type AssistantOutputBlock,
  type StreamingMessage,
} from '../../stores/turn.js';
import {
  AssistantSections,
  historyAssistantSections,
  useStableStreamingSections,
} from './assistantSections.js';

type HistoryAssistantMessage = SessionMessage & {
  readonly role: 'assistant';
  readonly turnId: string;
};

type AssistantMessageData = HistoryAssistantMessage | StreamingMessage;

const EMPTY_STREAMING_BLOCKS: readonly AssistantOutputBlock[] = [];

export const AssistantMessage = memo(function AssistantMessage({
  message,
  sessionId,
  toolResults,
  terminal,
}: {
  readonly message: AssistantMessageData;
  readonly sessionId: string;
  readonly toolResults: ReadonlyMap<string, ToolResult>;
  readonly terminal: boolean;
}): JSX.Element | null {
  const streaming = isStreamingMessage(message);
  // 两个 Hook 必须在两个阶段都保持相同顺序. 阶段切换只替换数据, 不替换 Message 外壳.
  const streamingSections = useStableStreamingSections(
    streaming ? message.blocks : EMPTY_STREAMING_BLOCKS,
  );
  const historySections = useMemo(
    () => streaming ? [] : historyAssistantSections([message], toolResults),
    [message, toolResults],
  );
  if (streaming && terminal && message.blocks.length === 0) return null;

  const sections = streaming ? streamingSections : historySections;

  // Server 分配的同一 Message ID 让父列表复用此组件, 从而避免落盘交接时重新播放入场动画.
  return (
    <div className="ema-message-shell flex mr-12 ema-bubble-in">
      <div className="flex min-w-20 w-full max-w-full flex-col">
        {streaming && message.blocks.length === 0 ? (
          <StreamingDots />
        ) : (
          <AssistantSections
            sections={sections}
            streaming={streaming && !terminal}
            turnId={message.turnId}
            sessionId={sessionId}
          />
        )}
      </div>
    </div>
  );
});

const StreamingDots = memo(function StreamingDots(): JSX.Element {
  return (
    <div className="flex h-4 items-center gap-1.5 py-2">
      {[0, 150, 300].map(delay => (
        <div
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ema-text-secondary)]"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
});
