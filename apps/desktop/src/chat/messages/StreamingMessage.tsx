// 渲染当前 Turn 中的一条流式 Assistant Message.

import { memo, type JSX } from 'react';
import type { StreamingMessage as StreamingMessageData } from '../../stores/turn.js';
import { AssistantSections, useStableLiveSections } from './assistantSections.js';

export const StreamingMessage = memo(function StreamingMessage({
  message,
  sessionId,
  terminal,
}: {
  readonly message: StreamingMessageData;
  readonly sessionId: string;
  readonly terminal: boolean;
}): JSX.Element | null {
  const sections = useStableLiveSections(message.blocks);
  if (terminal && message.blocks.length === 0) return null;

  return (
    <div className="ema-message-shell flex mr-12 ema-bubble-in">
      <div className="flex min-w-20 w-full max-w-full flex-col">
        {message.blocks.length === 0 ? (
          <StreamingDots />
        ) : (
          <AssistantSections
            sections={sections}
            streaming={!terminal}
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
