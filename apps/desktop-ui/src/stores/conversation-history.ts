// 把数据库消息还原成前端会话历史和工具展示切片。
/**
 * conversation-history.ts — pure history assembly helpers.
 *
 * No store imports, no side effects. Takes raw DB rows and turns them into
 * the ChatHistoryItem[] that the conversation store renders.
 */
import type {
  AssistantBlock,
  MessageWire,
  TurnWire,
  TurnMode,
  TurnStats,
  ToolResultBlock,
  MessageBlocks,
  MessageContentPart,
  MessageId,
  TurnId,
  ToolPresentation,
} from '@ema-agent/contracts';
import type { AttachmentInputWire } from '../api/turns.js';

// ── Types (re-exported so conversation-store.ts stays as the public facade) ──

export interface AssistantSlice {
  type: 'text';             text: string;
}
export interface AssistantSliceThinking {
  type: 'thinking';         thinking: string; done?: boolean;
}
export interface AssistantSliceToolUse {
  type: 'tool_use';         callId: string; name: string; args?: unknown;
                            partialArgs?: string;
                            result?: unknown; error?: { code: string; message: string };
                            presentation?: ToolPresentation;
  // ── 状态展示字段（8.2 Tool 块重做）──
  /** 流式创建时间戳，running 时算实时耗时用。刷新后无（DB 不存）。 */
  startedAt?: number;
  /** 完成耗时（ms）。流式由 tool_result 事件带回，刷新后从 ToolResultBlock.durationMs 还原。 */
  durationMs?: number;
  /** 失败原因码：'permission/denied' | 'policy/denied' | 'tool/error'。 */
  errorCode?: string;
  /** 权限等待中关联的 promptId。permission_resolved 时按此定位 slice。 */
  permissionPromptId?: string;
}
export interface AssistantSliceNarrative {
  type: 'narrative_status'; timelines: string[]; completedTimelines: string[];
                            snippets: Record<string, string>;
                            failedTimelines: Record<string, string>;
}
export type AnyAssistantSlice =
  | AssistantSlice
  | AssistantSliceThinking
  | AssistantSliceToolUse
  | AssistantSliceNarrative;

export interface StreamingAssistantMessage {
  role:      'assistant';
  content:   string;
  slices:    AnyAssistantSlice[];
  startedAt: number;
  turnId:    TurnId;
  mode?:     TurnMode;
}

export interface ChatHistoryItem {
  role:         'system' | 'user' | 'assistant' | 'error';
  content:      string;
  slices?:      AnyAssistantSlice[];
  createdAt:    number;
  messageId?:   MessageId;
  turnId?:      TurnId;
  stats?:       TurnStats;
  mode?:        TurnMode;
  attachments?: AttachmentInputWire[];
  /** narrative_context 检索块标记(前端渲染成 NarrativeStatusBlock 气泡) */
  kind?:        'narrative_context';
}

// ── Streaming slice helpers ────────────────────────────────────────────────────

export function appendTextSlice(slices: AnyAssistantSlice[], delta: string): AnyAssistantSlice[] {
  const last = slices[slices.length - 1];
  if (last?.type === 'text') {
    return [...slices.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...slices, { type: 'text', text: delta }];
}

export function appendThinkingSlice(slices: AnyAssistantSlice[], delta: string): AnyAssistantSlice[] {
  const last = slices[slices.length - 1];
  if (last?.type === 'thinking') {
    return [...slices.slice(0, -1), { ...last, thinking: last.thinking + delta }];
  }
  return [...slices, { type: 'thinking', thinking: delta }];
}

// ── Full history assembly ─────────────────────────────────────────────────────

/**
 * Rebuild chronological chat history from raw DB messages + their turns.
 *
 * Grouping invariant: a "group" only ever holds ASSISTANT content. Agent turns
 * persist as multiple assistant messages (think→act→think) plus tool_results
 * user-messages — we fold them back into ONE bubble so reload looks identical
 * to streaming. User messages share the same turnId as their reply, so they
 * must NEVER open a group (or the reply would merge into the user bubble).
 */
export function assembleHistory(messages: MessageWire[], turns: TurnWire[]): ChatHistoryItem[] {
  const turnById = new Map(turns.map((t) => [t.id, t]));
  const chronological = [...messages].reverse();   // listMessages is newest-first

  const out: ChatHistoryItem[] = [];
  let currentGroup: ChatHistoryItem | null = null;

  const flush = (): void => {
    if (!currentGroup) return;
    const turn = currentGroup.turnId ? turnById.get(currentGroup.turnId as string) : undefined;
    if (turn) {
      currentGroup.stats = {
        inputTokens:  turn.usageInputTokens,
        outputTokens: turn.usageOutputTokens,
        durationMs:   turn.completedAt !== null ? turn.completedAt - turn.startedAt : 0,
      };
      currentGroup.mode = turn.mode;
    }
    out.push(currentGroup);
    currentGroup = null;
  };

  const toItem = (m: MessageWire): ChatHistoryItem => {
    const { content, slices } = blocksToHistoryFields(m.role, m.blocks);
    const item: ChatHistoryItem = {
      role:      m.role as ChatHistoryItem['role'],
      content,
      slices,
      createdAt: m.createdAt,
      messageId: m.id as MessageId,
      turnId:    m.turnId !== null ? (m.turnId as TurnId) : undefined,
    };
    if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
      item.attachments = m.attachments.map((a) => ({
        id: a.id, name: a.name, mimeType: a.mimeType,
        size: a.size ?? 0, mtime: a.mtime ?? 0, localPath: a.localPath ?? '',
      }));
    }
    return item;
  };

  for (const m of chronological) {
    // narrative_context:检索结果独立成 item(不合并进 assistant group),
    // 带 narrative_status slice(完整 text,展开用)。重开 session 从 DB 重建不丢。
    if (m.kind === 'narrative_context') {
      flush();
      const b = m.blocks as { timelines?: Array<{ name: string; charCount: number; text: string }> };
      const timelines = b?.timelines ?? [];
      out.push({
        role:      'user',
        content:   '',
        kind:      'narrative_context',
        createdAt: m.createdAt,
        messageId: m.id as MessageId,
        turnId:    m.turnId !== null ? (m.turnId as TurnId) : undefined,
        slices:    [{
          type:              'narrative_status',
          timelines:         timelines.map((t) => t.name),
          completedTimelines: timelines.map((t) => t.name),
          snippets:          Object.fromEntries(timelines.map((t) => [t.name, t.text])),
          failedTimelines:   {},
        }],
      });
      continue;
    }

    if (m.kind !== 'normal' && m.kind !== 'summary' && m.kind !== 'tool_results') continue;

    if (m.kind === 'tool_results') {
      const blocks = m.blocks;
      const group  = currentGroup;
      if (!Array.isArray(blocks) || !group?.slices) continue;

      let working = group.slices;
      for (const block of blocks as ToolResultBlock[]) {
        if (block.type !== 'tool_result') continue;
        const idx = working.findIndex(
          (s) => s.type === 'tool_use' && s.callId === block.toolUseId,
        );
        if (idx === -1) continue;
        const target = working[idx];
        if (target?.type !== 'tool_use') continue;

        const updated: AnyAssistantSlice = {
          ...target,
          result: block.content,
          durationMs: block.durationMs,
          presentation: block.presentation,
          errorCode: block.errorCode ?? (block.isError ? 'tool/error' : undefined),
          ...(block.isError
            ? { error: { code: block.errorCode ?? 'tool/error', message: typeof block.content === 'string' ? block.content : '工具执行失败' } }
            : {}),
        };
        working = [...working.slice(0, idx), updated, ...working.slice(idx + 1)];
      }
      group.slices = working;
      continue;
    }

    if (m.role === 'user') {
      flush();
      out.push(toItem(m));
      continue;
    }

    if (m.role === 'assistant') {
      const item = toItem(m);

      if (!item.turnId) {
        flush();
        out.push(item);
        continue;
      }

      if (currentGroup && currentGroup.turnId === item.turnId) {
        if (item.slices) currentGroup.slices = [...(currentGroup.slices ?? []), ...item.slices];
        if (item.content) {
          currentGroup.content = currentGroup.content
            ? currentGroup.content + '\n' + item.content
            : item.content;
        }
      } else {
        flush();
        currentGroup = item;
      }
      continue;
    }
  }

  flush();
  return out;
}

// ── Private helper ────────────────────────────────────────────────────────────

function blocksToHistoryFields(
  role:   string,
  blocks: MessageBlocks,
): Pick<ChatHistoryItem, 'content' | 'slices'> {
  if (typeof blocks === 'string') return { content: blocks };

  if (role === 'assistant' && Array.isArray(blocks)) {
    const ab     = blocks as AssistantBlock[];
    const slices: AnyAssistantSlice[] = ab.map((b) => {
      if (b.type === 'text')     return { type: 'text'     as const, text: b.text };
      if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.thinking, done: true };
      return { type: 'tool_use' as const, callId: b.id, name: b.name, args: b.args };
    });
    const content = ab
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { content, slices };
  }

  if (Array.isArray(blocks)) {
    const textParts = (blocks as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    return { content: textParts.join('') };
  }

  return { content: JSON.stringify(blocks) };
}
