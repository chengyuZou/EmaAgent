// 把数据库消息还原成前端会话历史和工具展示切片。

import type {
  ExecutionProfile,
  NarrativePolicy,
} from '@ema-agent/session';
import type { TurnStats } from '@ema-agent/turn';
import type {
  AssistantBlock,
  MessageBlocks,
  ToolResultBlock,
} from '@ema-agent/session';
import type { SessionMessagesResult } from '../api/sessions.js';

/** 历史接口返回的消息（user 消息可能附带 attachments 投影）。 */
export type SessionHistoryMessage = SessionMessagesResult['messages'][number];
/** 历史接口返回的 Turn 快照。 */
export type SessionHistoryTurn = SessionMessagesResult['turns'][number];
/** 历史附件展示投影：路径不进传输层，内容经 attachments content 端点读取。 */
export type ChatHistoryAttachment =
  Extract<SessionHistoryMessage, { attachments: readonly unknown[] }>['attachments'][number];

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
  // ── 状态展示字段（8.2 Tool 块重做）──
  /** 流式创建时间戳，running 时算实时耗时用。刷新后无（DB 不存）。 */
  startedAt?: number;
  /** 完成耗时（ms）。流式由 tool_result 事件带回，刷新后从 ToolResultBlock.durationMs 还原。 */
  durationMs?: number;
  /** 失败原因码：'permission/denied' | 'policy/denied' | 'tool/error'。 */
  errorCode?: string;
  /** 权限等待中；permission_required/resolved 按 slice.callId ↔ event.toolCallId 匹配。 */
  permissionPending?: boolean;
}
export interface AssistantSliceNarrative {
  type: 'narrative_status'; status: 'running' | 'completed' | 'failed' | 'interrupted';
                            timelines: string[]; completedTimelines: string[];
                            snippets: Record<string, string>;
                            failedTimelines: Record<string, string>;
                            message?: string;
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
  turnId:    string;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
}

export interface ChatHistoryItem {
  role:         'system' | 'user' | 'assistant' | 'error';
  content:      string;
  slices?:      AnyAssistantSlice[];
  createdAt:    number;
  messageId?:   string;
  turnId?:      string;
  stats?:       TurnStats;
  executionProfile?: ExecutionProfile;
  narrativePolicy?: NarrativePolicy;
  attachments?: ChatHistoryAttachment[];
}

export function createOptimisticUserMessage(
  turnId: string,
  text: string,
  createdAt = Date.now(),
): ChatHistoryItem {
  return {
    role: 'user',
    content: text,
    createdAt,
    turnId,
  };
}

export function reconcileLoadedHistory(
  loaded: ChatHistoryItem[],
  cached: ChatHistoryItem[],
): ChatHistoryItem[] {
  const loadedUserTurns = new Set(
    loaded
      .filter((item) => item.role === 'user' && item.turnId)
      .map((item) => item.turnId as string),
  );
  const pendingUsers = cached.filter((item) => (
    item.role === 'user'
      && item.messageId === undefined
      && item.turnId !== undefined
      && !loadedUserTurns.has(item.turnId as string)
  ));

  return [...loaded, ...pendingUsers].sort((left, right) => left.createdAt - right.createdAt);
}

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

/**
 * 一个聚合气泡只容纳 assistant 内容。Agent Turn 会把思考、动作和结果分多条持久化，
 * 恢复时按 Turn 合并，才能与流式阶段保持一致；同 Turn 的用户消息不能开启该聚合组。
 */
export function assembleHistory(
  messages: SessionHistoryMessage[],
  turns: SessionHistoryTurn[],
  order: 'newestFirst' | 'oldestFirst' = 'newestFirst',
): ChatHistoryItem[] {
  const turnById = new Map(turns.map((t) => [t.id, t]));
  const chronological = order === 'newestFirst'
    ? [...messages].reverse()
    : messages;

  const out: ChatHistoryItem[] = [];
  let currentGroup: ChatHistoryItem | null = null;

  const flush = (): void => {
    if (!currentGroup) return;
    const turn = currentGroup.turnId ? turnById.get(currentGroup.turnId as string) : undefined;
    if (turn) {
      currentGroup.stats = {
        inputTokens:  turn.usageInputTokens,
        outputTokens: turn.usageOutputTokens,
        durationMs:   turn.completedAt !== null ? turn.completedAt - turn.createdAt : 0,
      };
      currentGroup.executionProfile = turn.executionProfile;
      currentGroup.narrativePolicy = turn.narrativePolicy;
    }
    out.push(currentGroup);
    currentGroup = null;
  };

  const toItem = (m: SessionHistoryMessage): ChatHistoryItem => {
    const { content, slices } = blocksToHistoryFields(m.role, m.blocks);
    const item: ChatHistoryItem = {
      role:      m.role as ChatHistoryItem['role'],
      content,
      slices,
      createdAt: m.createdAt,
      messageId: m.id,
      turnId:    m.turnId !== null ? (m.turnId) : undefined,
    };
    const attachments = 'attachments' in m ? m.attachments : undefined;
    if (m.role === 'user' && attachments && attachments.length > 0) {
      item.attachments = [...attachments];
    }
    return item;
  };

  for (const m of chronological) {
    if (m.kind !== 'normal' && m.kind !== 'summary' && m.kind !== 'tool_results') continue;

    if (m.kind === 'tool_results') {
      const blocks = m.blocks;
      const group  = currentGroup;
      if (!Array.isArray(blocks) || !group?.slices) continue;

      let working = group.slices;
      for (const block of blocks as ToolResultBlock[]) {
        if (block.type !== 'tool_result') continue;
        const idx = working.findIndex(
          (s) => s.type === 'tool_use' && s.callId === block.toolCallId,
        );
        if (idx === -1) continue;
        const target = working[idx];
        if (target?.type !== 'tool_use') continue;

        const updated: AnyAssistantSlice = {
          ...target,
          // 类型化 data 优先(供专属 UI);老消息没有 data 槽,回落模型内容。
          result: block.data ?? block.content,
          durationMs: block.durationMs,
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
      if (b.type === 'reasoning') {
        return { type: 'thinking' as const, thinking: b.summaryText ?? '', done: true };
      }
      if (b.type === 'gemini_thought') {
        return { type: 'thinking' as const, thinking: b.text, done: true };
      }
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
