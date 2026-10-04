// 把一条持久或流式消息交给对应的具体渲染组件.

import type { JSX } from 'react';
import type { SessionMessage } from '@ema-agent/session';
import type { SubagentMessage } from '@ema-agent/agent';
import type { ToolResult } from '@ema-agent/tools';
import { isStreamingMessage, type AssistantOutputBlock, type StreamingMessage as StreamingMessageData } from '../../stores/turn.js';
import { AssistantMessage } from './AssistantMessage.js';
import { UserMessage } from './UserMessage.js';

export function UIMessage({
  message,
  sessionId,
  toolResults,
  terminal,
  streamingBlocks,
}: {
  readonly message: SessionMessage | SubagentMessage | StreamingMessageData;
  readonly sessionId: string;
  readonly toolResults: ReadonlyMap<string, ToolResult>;
  readonly terminal: boolean;
  readonly streamingBlocks?: readonly AssistantOutputBlock[];
}): JSX.Element | null {
  // StreamingMessage 不是持久 SessionMessage, 但 Assistant 两个阶段必须进入同一组件类型.
  if (isStreamingMessage(message)) {
    return (
      <AssistantMessage
        message={message}
        sessionId={sessionId}
        toolResults={toolResults}
        terminal={terminal}
      />
    );
  }
  if (message.kind === 'summary') {
    return <SessionSummary message={message} />;
  }
  if (message.role === 'user') {
    return (
      <UserMessage message={message} sessionId={sessionId} />
    );
  }
  if (message.role === 'assistant') {
    return (
      <AssistantMessage
        message={message}
        sessionId={sessionId}
        toolResults={toolResults}
        terminal={terminal}
        streamingBlocks={streamingBlocks}
      />
    );
  }
  return null;
}

export function toolResultsForMessages(messages: readonly (SessionMessage | SubagentMessage | StreamingMessageData)[]): ReadonlyMap<string, ToolResult> {
  // tool_results 是持久数据关系, 不作为独立可见行. Tool UI 按 toolCallId 取回对应结果.
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    if (isStreamingMessage(message) || message.kind !== 'tool_results'
      || !Array.isArray(message.blocks)) {
      continue;
    }
    for (const block of message.blocks as ToolResult[]) {
      if (block.type === 'tool_result') {
        results.set(block.toolCallId, block);
      }
    }
  }
  return results;
}

const tokenCountFormatter = new Intl.NumberFormat('zh-CN');

function SessionSummary({ message }: { readonly message: SessionMessage | SubagentMessage }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-3 text-xs text-[var(--ema-text-secondary)]">
      <span className="i-ema:context-compact size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 whitespace-nowrap">上下文已压缩</span>
      {message.savedTokens !== undefined && (
        <span className="whitespace-nowrap tabular-nums text-[var(--ema-text-tertiary)]">
          压缩约 {tokenCountFormatter.format(message.savedTokens)} Tokens
        </span>
      )}
    </div>
  );
}
