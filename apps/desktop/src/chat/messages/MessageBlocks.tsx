// Session 历史消息的 Turn 布局分组、通用块文本与 Tool Result 索引.
// 消息从 RPC 到组件不变形：分组持有原始消息引用，不合成伪 Message、不改字段名、
// 不融合 tool_use 与 tool_result。

import type { ToolResult } from '@ema-agent/tools';
import type { AttachmentBlock, SessionUserBlock } from '@ema-agent/session';
import type {
  SessionHistoryMessage,
} from '../../api/sessions.js';

/**
 * 同一 Turn 的消息布局分组：一个 Agent Turn 会把思考、动作和结果分多条持久化，
 * 渲染时按 Turn 聚合成一个气泡的视觉单元。组内是原始消息引用，不合成伪 Message。
 */
export interface TurnMessageGroup {
  readonly turnId: string | null;
  readonly messages: readonly SessionHistoryMessage[];
}

export function chipMetaForPath(filePath: string): {
  icon: string;
  color: string;
} {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';

  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    return { icon: 'i-mdi:image-outline', color: 'var(--ema-file-image)' };
  }
  if (extension === 'pdf') {
    return { icon: 'i-mdi:file-pdf-box', color: 'var(--ema-file-pdf)' };
  }
  if (['doc', 'docx'].includes(extension)) {
    return { icon: 'i-mdi:file-word', color: 'var(--ema-file-word)' };
  }
  if (['ppt', 'pptx'].includes(extension)) {
    return { icon: 'i-mdi:file-powerpoint', color: 'var(--ema-file-ppt)' };
  }
  if (['xls', 'xlsx'].includes(extension)) {
    return { icon: 'i-mdi:file-excel', color: 'var(--ema-file-excel)' };
  }
  if (/^(ts|tsx|js|jsx|py|rs|go|cpp|c|java|rb|php|sh|yaml|yml|toml|sql)$/.test(extension)) {
    return { icon: 'i-mdi:file-code-outline', color: 'var(--ema-file-code)' };
  }
  if (['txt', 'md', 'log', 'csv', 'json'].includes(extension)) {
    return {
      icon: 'i-mdi:file-document-outline',
      color: 'var(--ema-file-text)',
    };
  }

  return { icon: 'i-lucide:paperclip', color: 'var(--ema-file-other)' };
}

export function chipDisplay(block: AttachmentBlock): {
  icon: string;
  color: string;
  label: string;
} {
  switch (block.type) {
    case 'image_reference':
      return {
        icon: 'i-mdi:image-outline',
        color: 'var(--ema-file-image)',
        label: block.name ?? '剪贴板图片',
      };
    case 'pasted_text_reference':
      return {
        icon: 'i-lucide:clipboard-paste',
        color: 'var(--ema-warning)',
        label: '粘贴文本',
      };
    case 'file_reference': {
      const meta = chipMetaForPath(block.path);
      return {
        ...meta,
        label: block.path.split(/[\\/]/).pop() ?? block.path,
      };
    }
  }
}

/**
 * 把按时间正序的历史消息分成 Turn 布局组。
 * user/system 消息自成一组；assistant 消息按 turnId 连续合并；tool_results 不进组
 * （渲染侧经 toolResultIndex 关联回 tool_use，不进入气泡块序列）。
 */
export function groupMessagesByTurn(
  messages: readonly SessionHistoryMessage[],
): TurnMessageGroup[] {
  const groups: TurnMessageGroup[] = [];
  let current: SessionHistoryMessage[] = [];
  let currentTurnId: string | null | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const turnId = currentTurnId ?? null;
    groups.push({ turnId, messages: current });
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
): Map<string, ToolResult> {
  const index = new Map<string, ToolResult>();
  for (const message of messages) {
    if (message.kind !== 'tool_results' || !Array.isArray(message.blocks)) continue;
    for (const block of message.blocks as ToolResult[]) {
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
      (block): block is Extract<SessionUserBlock, { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}
