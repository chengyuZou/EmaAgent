// 渲染一条已经持久化的 Assistant Message.

import { memo, useMemo, type JSX } from 'react';
import type { SessionMessage } from '@ema-agent/session';
import type { ToolResult } from '@ema-agent/tools';
import { AssistantSections, historyAssistantSections } from './assistantSections.js';

export const AssistantMessage = memo(function AssistantMessage({
  message,
  toolResults,
}: {
  readonly message: SessionMessage & { readonly turnId: string };
  readonly toolResults: ReadonlyMap<string, ToolResult>;
}): JSX.Element {
  const sections = useMemo(
    () => historyAssistantSections([message], toolResults),
    [message, toolResults],
  );

  return (
    <div className="ema-message-shell flex mr-12 ema-bubble-in">
      <div className="flex min-w-20 w-full max-w-full flex-col">
        <AssistantSections
          sections={sections}
          streaming={false}
          turnId={message.turnId}
          sessionId={message.sessionId}
        />
      </div>
    </div>
  );
});
