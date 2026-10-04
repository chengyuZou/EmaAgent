// 用同一个渲染身份承接 Assistant Message 的流式阶段与持久 History 阶段.

import { memo, useMemo, type JSX } from 'react';
import type { SessionMessage } from '@ema-agent/session';
import type { SubagentMessage } from '@ema-agent/agent';
import type { ToolResult } from '@ema-agent/tools';
import { isStreamingMessage, type AssistantOutputBlock, type StreamingMessage } from '../../stores/turn.js';
import { AssistantSections, historyAssistantSections, useStableStreamingSections } from './assistantSections.js';

type AssistantMessageData = SessionMessage | SubagentMessage | StreamingMessage;

const EMPTY_STREAMING_BLOCKS: readonly AssistantOutputBlock[] = [];

export const AssistantMessage = memo(function AssistantMessage({
  message,
  sessionId,
  toolResults,
  terminal,
  streamingBlocks,
}: {
  readonly message: AssistantMessageData;
  readonly sessionId: string;
  readonly toolResults: ReadonlyMap<string, ToolResult>;
  readonly terminal: boolean;
  /** 子代理原生 Message 的实时屏幕块, 不伪造根 Turn 的 StreamingMessage. */
  readonly streamingBlocks?: readonly AssistantOutputBlock[];
}): JSX.Element | null {
  const rootStreaming = isStreamingMessage(message);
  const streaming = rootStreaming || streamingBlocks !== undefined;
  // 两个 Hook 必须在两个阶段都保持相同顺序. 阶段切换只替换数据, 不替换 Message 外壳.
  const streamingSections = useStableStreamingSections(rootStreaming ? message.blocks : streamingBlocks ?? EMPTY_STREAMING_BLOCKS);
  const historySections = useMemo(() => {
    if (streaming || isStreamingMessage(message)) {
      return [];
    }
    return historyAssistantSections([message], toolResults);
  }, [message, toolResults, streaming]);
  const emptyStreaming = rootStreaming
    ? message.blocks.length === 0
    : streamingBlocks?.length === 0;
  if (streaming && terminal && emptyStreaming) {
    return null;
  }

  const sections = streaming ? streamingSections : historySections;

  // 历史行会因虚拟化反复挂载, mount 不代表新消息到达.
  return (
    <div className="ema-message-shell flex">
      <div className="flex min-w-20 w-full max-w-full flex-col">
        {streaming && emptyStreaming
          ? (
            <StreamingDots />
          )
          : (
            <AssistantSections
              sections={sections}
              streaming={streaming && !terminal}
              turnId={'turnId' in message ? message.turnId ?? undefined : undefined}
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
