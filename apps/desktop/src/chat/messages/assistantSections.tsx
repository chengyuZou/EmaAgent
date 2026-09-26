// 按 Server 给出的块顺序渲染正文, Thinking, 普通 Tool Group 和 Agent Group.

import { memo, useRef, useState, type JSX } from 'react';
import type { AssistantBlock } from '@ema-agent/llm';
import type { SubagentMessage } from '@ema-agent/agent';
import type { Message } from '@ema-agent/session';
import type { ToolResult } from '@ema-agent/tools';
import { Markdown } from '@ema-agent/ui';
import type { AssistantOutputBlock } from '../../stores/turn.js';
import { AgentGroup } from './toolBlocks/AgentGroup.js';
import { ToolGroup } from './toolBlocks/ToolGroup.js';
import {
  isAskUserCall,
  isSubagentCall,
  toolCallId,
  toolPermissionPending,
  type ToolDisplayCall,
} from './toolBlocks/toolGroups.js';

type DisplayBlock = Exclude<AssistantBlock, { readonly type: 'tool_use' }>;

export type AssistantContentSection =
  | {
      readonly kind: 'block';
      readonly key: string;
      readonly block: DisplayBlock;
      readonly thinkingActive: boolean;
    }
  | { readonly kind: 'tool_group'; readonly key: string; readonly calls: readonly ToolDisplayCall[] }
  | { readonly kind: 'agent_group'; readonly key: string; readonly calls: readonly ToolDisplayCall[] };

export function AssistantSections({
  sections,
  streaming,
  turnId,
  sessionId,
}: {
  readonly sections: readonly AssistantContentSection[];
  readonly streaming: boolean;
  readonly turnId?: string;
  readonly sessionId: string;
}): JSX.Element {
  return (
    <div className="ema-message-content flex min-w-0 flex-col gap-2 text-sm text-[var(--ema-text-secondary)]">
      {sections.map(section => {
        if (section.kind === 'tool_group') {
          return (
            <ToolGroup
              key={section.key}
              calls={section.calls}
              streaming={streaming}
              turnId={turnId}
              sessionId={sessionId}
            />
          );
        }
        if (section.kind === 'agent_group') {
          return (
            <AgentGroup
              key={section.key}
              calls={section.calls}
              streaming={streaming}
              turnId={turnId}
              sessionId={sessionId}
            />
          );
        }
        return (
          <AssistantBlockView
            key={section.key}
            block={section.block}
            streaming={section.thinkingActive}
          />
        );
      })}
    </div>
  );
}

const AssistantBlockView = memo(function AssistantBlockView({
  block,
  streaming,
}: {
  readonly block: DisplayBlock;
  readonly streaming: boolean;
}): JSX.Element | null {
  switch (block.type) {
    case 'text':
      return <Markdown source={block.text} />;
    case 'thinking':
      return <ThinkingBlock text={block.thinking} streaming={streaming} />;
    case 'reasoning':
      return block.summaryText
        ? <ThinkingBlock text={block.summaryText} streaming={streaming} />
        : null;
    case 'gemini_thought':
      return <ThinkingBlock text={block.text} streaming={streaming} />;
  }
});

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming,
}: {
  readonly text: string;
  readonly streaming: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="ema-thinking-block">
      <button
        type="button"
        className="ema-thinking-summary"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="i-lucide:brain-circuit" aria-hidden />
        <span>{streaming ? '正在思考' : '思考过程'}</span>
        <span className="i-lucide:chevron-right ema-thinking-chevron" aria-hidden />
      </button>
      <div
        className="ema-collapsible ema-chat-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          <div className="ema-thinking-content">
            <Markdown source={text} />
          </div>
        </div>
      </div>
    </div>
  );
});

export function historyAssistantSections(
  messages: readonly (Message | SubagentMessage)[],
  results: ReadonlyMap<string, ToolResult>,
): AssistantContentSection[] {
  const content: Array<DisplayBlock | ToolDisplayCall> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.blocks)) continue;
    for (const block of message.blocks as readonly AssistantBlock[]) {
      content.push(block.type === 'tool_use'
        ? {
            source: 'history',
            block,
            ...(results.has(block.id) ? { result: results.get(block.id)! } : {}),
          }
        : block);
    }
  }
  return groupContent(content, false);
}

function streamingAssistantSections(blocks: readonly AssistantOutputBlock[]): AssistantContentSection[] {
  return groupContent(blocks.map(block => block.type === 'tool_use'
    ? { source: 'streaming' as const, item: block }
    : block), true);
}

function groupContent(
  content: readonly (DisplayBlock | ToolDisplayCall)[],
  streaming: boolean,
): AssistantContentSection[] {
  const sections: AssistantContentSection[] = [];
  let tools: ToolDisplayCall[] = [];
  let agents: ToolDisplayCall[] = [];
  let blockIndex = 0;
  const flushTools = (): void => {
    if (tools.length === 0) return;
    sections.push({ kind: 'tool_group', key: `tools:${toolCallId(tools[0]!)}`, calls: tools });
    tools = [];
  };
  const flushAgents = (): void => {
    if (agents.length === 0) return;
    sections.push({ kind: 'agent_group', key: `agents:${toolCallId(agents[0]!)}`, calls: agents });
    agents = [];
  };

  for (const item of content) {
    if ('source' in item) {
      if (isAskUserCall(item) || (streaming && toolPermissionPending(item))) {
        flushTools();
        flushAgents();
      } else if (isSubagentCall(item)) {
        flushTools();
        agents.push(item);
      } else {
        flushAgents();
        tools.push(item);
      }
      continue;
    }
    flushTools();
    flushAgents();
    sections.push({
      kind: 'block',
      key: `block:${blockIndex}`,
      block: item,
      thinkingActive: streaming
        && item.type === 'thinking'
        && 'done' in item
        && item.done === false,
    });
    blockIndex += 1;
  }
  flushTools();
  flushAgents();
  return sections;
}

/** Text delta 会重建当前 Text item, 但已经完成的 Tool/Agent section 继续复用原对象. */
export function useStableStreamingSections(
  blocks: readonly AssistantOutputBlock[],
): readonly AssistantContentSection[] {
  const previous = useRef<readonly AssistantContentSection[]>([]);
  const next = streamingAssistantSections(blocks).map((section, index) => {
    const old = previous.current[index];
    if (!old || old.kind !== section.kind || old.key !== section.key) return section;
    if (section.kind === 'block' && old.kind === 'block' && old.block === section.block) return old;
    if (section.kind !== 'block' && old.kind !== 'block' && sameCalls(old.calls, section.calls)) return old;
    return section;
  });
  previous.current = next;
  return next;
}

function sameCalls(left: readonly ToolDisplayCall[], right: readonly ToolDisplayCall[]): boolean {
  return left.length === right.length && left.every((call, index) => {
    const other = right[index];
    return call.source === 'streaming' && other?.source === 'streaming' && call.item === other.item;
  });
}
