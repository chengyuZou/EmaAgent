// 把一条持久或流式消息交给对应的具体渲染组件.

import type { JSX } from 'react';
import type { Message, MessageBlocks, SessionMessage, SessionUserBlock } from '@ema-agent/session';
import type { ToolResult } from '@ema-agent/tools';
import { Markdown } from '@ema-agent/ui';
import {
  isStreamingMessage,
  type StreamingMessage as StreamingMessageData,
} from '../../stores/turn.js';
import { AssistantMessage } from './AssistantMessage.js';
import { StreamingMessage } from './StreamingMessage.js';
import { UserMessage } from './UserMessage.js';

export function UIMessage({
  message,
  sessionId,
  toolResults,
  terminal,
}: {
  readonly message: SessionMessage | StreamingMessageData;
  readonly sessionId: string;
  readonly toolResults: ReadonlyMap<string, ToolResult>;
  readonly terminal: boolean;
}): JSX.Element | null {
  if (isStreamingMessage(message)) {
    return (
      <StreamingMessage
        message={message}
        sessionId={sessionId}
        terminal={terminal}
      />
    );
  }
  if (message.kind === 'summary') return <SessionSummary message={message} />;
  if (message.role === 'user') return <UserMessage message={message} />;
  if (message.role === 'assistant' && hasTurnId(message)) {
    return <AssistantMessage message={message} toolResults={toolResults} />;
  }
  return null;
}

function hasTurnId(message: SessionMessage): message is SessionMessage & { readonly turnId: string } {
  return message.turnId !== null;
}

export function toolResultsForMessages(
  messages: readonly (SessionMessage | StreamingMessageData)[],
): ReadonlyMap<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    if (isStreamingMessage(message) || message.kind !== 'tool_results' || !Array.isArray(message.blocks)) {
      continue;
    }
    for (const block of message.blocks as ToolResult[]) {
      if (block.type === 'tool_result') results.set(block.toolCallId, block);
    }
  }
  return results;
}

function SessionSummary({ message }: { readonly message: Message }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-[var(--ema-text-tertiary)]">
      <span className="i-lucide:fold-horizontal" aria-hidden />
      <span>上下文已压缩</span>
      <span className="line-clamp-1 opacity-60">
        <Markdown source={messageText(message)} />
      </span>
    </div>
  );
}

function messageText(message: { readonly blocks: MessageBlocks }): string {
  if (typeof message.blocks === 'string') return message.blocks;
  if (!Array.isArray(message.blocks)) return '';
  return message.blocks
    .filter((block): block is Extract<SessionUserBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}
