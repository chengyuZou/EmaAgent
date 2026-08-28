// Session 历史消息的 Turn 布局分组与 Tool Result 索引（纯函数）。
// 消息从 RPC 到组件不变形：分组持有原始消息引用，不合成伪 Message、不改字段名、
// 不融合 tool_use 与 tool_result。

import type { ToolResultBlock } from '@ema-agent/session';
import type {
  SessionHistoryMessage,
  SessionHistoryTurn,
} from '../../api/sessions.js';

/**
 * 同一 Turn 的消息布局分组：一个 Agent Turn 会把思考、动作和结果分多条持久化，
 * 渲染时按 Turn 聚合成一个气泡的视觉单元。组内是原始消息引用，不合成伪 Message。
 */
export interface TurnMessageGroup {
  readonly turnId: string | null;
  readonly messages: readonly SessionHistoryMessage[];
  readonly turn?: SessionHistoryTurn;
}

/**
 * 把按时间正序的历史消息分成 Turn 布局组。
 * user/system 消息自成一组；assistant 消息按 turnId 连续合并；tool_results 不进组
 * （渲染侧经 toolResultIndex 关联回 tool_use，不进入气泡块序列）。
 */
export function groupMessagesByTurn(
  messages: readonly SessionHistoryMessage[],
  turns: readonly SessionHistoryTurn[],
): TurnMessageGroup[] {
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const groups: TurnMessageGroup[] = [];
  let current: SessionHistoryMessage[] = [];
  let currentTurnId: string | null | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const turnId = currentTurnId ?? null;
    groups.push({
      turnId,
      messages: current,
      ...(turnId !== null && turnById.has(turnId)
        ? { turn: turnById.get(turnId)! }
        : {}),
    });
    current = [];
    currentTurnId = undefined;
  };

  for (const message of messages) {
    if (message.kind === 'tool_results') continue;
    const belongsToAssistantGroup = message.role === 'assistant' && message.turnId !== null;
    if (belongsToAssistantGroup && currentTurnId === message.turnId) {
      current.push(message);
      continue;
    }
    flush();
    current = [message];
    currentTurnId = belongsToAssistantGroup ? message.turnId : null;
  }
  flush();
  return groups;
}

/** tool_results 消息的索引：渲染 tool_use 块时按 toolCallId 查询对应 ToolResult。 */
export function toolResultIndex(
  messages: readonly SessionHistoryMessage[],
): Map<string, ToolResultBlock> {
  const index = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    if (message.kind !== 'tool_results' || !Array.isArray(message.blocks)) continue;
    for (const block of message.blocks as ToolResultBlock[]) {
      if (block.type === 'tool_result') index.set(block.toolCallId, block);
    }
  }
  return index;
}

/** 消息正文显示文本：字符串块直接用，数组块取 text 部分拼接。 */
export function messageText(message: SessionHistoryMessage): string {
  const blocks = message.blocks;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object'
        && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}
