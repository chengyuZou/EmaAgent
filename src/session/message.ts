// 定义 Session 持久化消息结构，并在数据库 JSON 进入业务层时完成校验。
import type {
  AssistantBlock as LlmAssistantBlock,
  ToolResultContentPart,
} from '@ema-agent/llm';
import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type { TurnContentPart } from '@ema-agent/turn';
import type { ToolResult } from '@ema-agent/tools';

export type AssistantBlock = LlmAssistantBlock;
export type MessageContentPart = TurnContentPart;

export interface NarrativeTimelineRecall {
  name: string;
  charCount: number;
  text: string;
}

export interface NarrativeContextBlocks {
  timelines: NarrativeTimelineRecall[];
}

/** 附件正文不进入 Message JSON；这里只保存可回查 turn_attachments 的稳定引用。 */
export interface AttachmentReferenceBlock {
  type: 'attachment_ref';
  attachmentId: string;
  name: string;
  mimeType: string;
}

/** ToolResult 信封即持久块; data/durationMs/errorCode 都在信封上, 不再重复投影。 */
export type ToolResultBlock = ToolResult;

export type UserBlock = MessageContentPart | ToolResultBlock | AttachmentReferenceBlock;
export type MessageBlocks = string | AssistantBlock[] | UserBlock[] | NarrativeContextBlocks;

const INVALID_MESSAGE_PLACEHOLDER = '[消息内容无法读取]';

/** 数据库中的未知 JSON 只能在这里转换为 Session MessageBlocks。 */
export function parseMessageBlocksJson(
  raw: string,
  role: MessageRole,
  kind: MessageKind,
): MessageBlocks {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return INVALID_MESSAGE_PLACEHOLDER;
  }

  if (kind === 'narrative_context') {
    return isNarrativeContextBlocks(value) ? value : INVALID_MESSAGE_PLACEHOLDER;
  }
  if (role === 'system') {
    return typeof value === 'string' ? value : INVALID_MESSAGE_PLACEHOLDER;
  }
  if (role === 'assistant') {
    return isAssistantBlocks(value) ? value : INVALID_MESSAGE_PLACEHOLDER;
  }
  if (typeof value === 'string') return value;
  return isUserBlocks(value) ? value : INVALID_MESSAGE_PLACEHOLDER;
}

function isNarrativeContextBlocks(value: unknown): value is NarrativeContextBlocks {
  if (!isRecord(value) || !Array.isArray(value.timelines)) return false;
  return value.timelines.every((timeline) => (
    isRecord(timeline)
    && typeof timeline.name === 'string'
    && typeof timeline.charCount === 'number'
    && typeof timeline.text === 'string'
  ));
}

function isAssistantBlocks(value: unknown): value is AssistantBlock[] {
  return Array.isArray(value) && value.every((block) => {
    if (!isRecord(block) || typeof block.type !== 'string') return false;
    if (block.type === 'text') return typeof block.text === 'string';
    if (block.type === 'thinking') {
      return typeof block.thinking === 'string'
        && (block.signature === undefined || typeof block.signature === 'string');
    }
    return block.type === 'tool_use'
      && typeof block.id === 'string'
      && typeof block.name === 'string'
      && 'args' in block;
  });
}

function isUserBlocks(value: unknown): value is UserBlock[] {
  return Array.isArray(value) && value.every((block) => (
    isTurnContentPart(block) || isToolResultBlock(block) || isAttachmentReferenceBlock(block)
  ));
}

function isAttachmentReferenceBlock(value: unknown): value is AttachmentReferenceBlock {
  return isRecord(value)
    && value.type === 'attachment_ref'
    && typeof value.attachmentId === 'string'
    && typeof value.name === 'string'
    && typeof value.mimeType === 'string';
}

function isToolResultBlock(value: unknown): value is ToolResultBlock {
  if (!isRecord(value) || value.type !== 'tool_result' || typeof value.toolCallId !== 'string') {
    return false;
  }
  if (!(typeof value.content === 'string' || isToolResultParts(value.content))) return false;
  if (value.isError !== undefined && typeof value.isError !== 'boolean') return false;
  if (value.durationMs !== undefined && typeof value.durationMs !== 'number') return false;
  return value.errorCode === undefined || typeof value.errorCode === 'string';
}

function isToolResultParts(value: unknown): value is ToolResultContentPart[] {
  return Array.isArray(value) && value.every((part) => {
    if (!isRecord(part)) return false;
    if (part.type === 'text') return typeof part.text === 'string';
    if (part.type === 'image_url') {
      return typeof part.url === 'string'
        && isOptionalNumber(part.width)
        && isOptionalNumber(part.height);
    }
    return part.type === 'image_data'
      && typeof part.data === 'string'
      && typeof part.mimeType === 'string'
      && isOptionalNumber(part.width)
      && isOptionalNumber(part.height);
  });
}

function isTurnContentPart(value: unknown): value is TurnContentPart {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string';
    case 'image_url':
      return typeof value.url === 'string'
        && isOptionalString(value.name)
        && isOptionalNumber(value.width)
        && isOptionalNumber(value.height);
    case 'image_data':
      return typeof value.data === 'string'
        && typeof value.mimeType === 'string'
        && isOptionalString(value.name)
        && isOptionalNumber(value.width)
        && isOptionalNumber(value.height);
    case 'audio_data':
      return typeof value.data === 'string'
        && typeof value.mimeType === 'string'
        && isOptionalString(value.name)
        && isOptionalNumber(value.durationMs);
    case 'file_data':
      return typeof value.data === 'string'
        && typeof value.mimeType === 'string'
        && isOptionalString(value.filename)
        && isOptionalNumber(value.pageCount);
    case 'file_url':
      return typeof value.url === 'string'
        && typeof value.mimeType === 'string'
        && isOptionalString(value.filename)
        && isOptionalNumber(value.pageCount);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
