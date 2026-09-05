// 定义 Session 持久化消息结构，并在数据库 JSON 进入业务层时完成校验。
import type {
  AssistantBlock,
  ContentPart,
  ToolResultContentPart,
} from '@ema-agent/llm';
import type { MessageRole } from '@ema-agent/storage';
import type { ToolResult } from '@ema-agent/tools';

/**
 * 附件块只保存落盘事实的绝对路径:图片=受管规范化副本,粘贴文本=落盘 txt,
 * 其他文件=用户原路径。path 是模型与文件之间的唯一桥。
 */
export interface ImageReferenceBlock {
  type: 'image_reference';
  path: string;
  /** 拖入图片的原文件名;剪贴板图片没有原生名,缺省。 */
  name?: string;
}

export interface PastedTextReferenceBlock {
  type: 'pasted_text_reference';
  path: string;
  /** 粘贴落盘时定格的前若干字符,让模型不盲读;组装零 IO。 */
  preview: string;
}

export interface FileReferenceBlock {
  type: 'file_reference';
  path: string;
}

export type AttachmentBlock =
  | ImageReferenceBlock
  | PastedTextReferenceBlock
  | FileReferenceBlock;

/**
 * 用户显式选中的 Skill;绝对 SKILL.md path 是身份,name 用于历史展示。
 */
export interface SkillReferenceBlock {
  type: 'skill_reference';
  name: string;
  path: string;
}

/**
 * 落盘的用户消息块:线上格式(llm UserBlock)的超集,多附件与 Skill 两种
 * 引用块——它们必须先经投影才能下发模型。ToolResult 信封即持久块,
 * data/durationMs/errorCode 都在信封上,不再重复投影。
 */
export type SessionUserBlock = ContentPart | ToolResult | AttachmentBlock | SkillReferenceBlock;
export type MessageBlocks = string | AssistantBlock[] | SessionUserBlock[];

const INVALID_MESSAGE_PLACEHOLDER = '[消息内容无法读取]';

/** 数据库中的未知 JSON 只能在这里转换为 Session MessageBlocks。 */
export function parseMessageBlocksJson(
  raw: string,
  role: MessageRole,
): MessageBlocks {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return INVALID_MESSAGE_PLACEHOLDER;
  }

  if (role === 'system') {
    return typeof value === 'string' ? value : INVALID_MESSAGE_PLACEHOLDER;
  }
  if (role === 'assistant') {
    return isAssistantBlocks(value) ? value : INVALID_MESSAGE_PLACEHOLDER;
  }
  if (typeof value === 'string') return value;
  return isSessionUserBlocks(value) ? value : INVALID_MESSAGE_PLACEHOLDER;
}

function isAssistantBlocks(value: unknown): value is AssistantBlock[] {
  return Array.isArray(value) && value.every((block) => {
    if (!isRecord(block) || typeof block.type !== 'string') return false;
    if (block.type === 'text') return typeof block.text === 'string';
    if (block.type === 'thinking') {
      return typeof block.thinking === 'string'
        && (block.signature === undefined || typeof block.signature === 'string');
    }
    if (block.type === 'reasoning') {
      return typeof block.id === 'string'
        && (block.summaryText === undefined || typeof block.summaryText === 'string')
        && (block.encryptedContent === undefined || typeof block.encryptedContent === 'string');
    }
    if (block.type === 'gemini_thought') {
      return typeof block.text === 'string'
        && (block.thoughtSignature === undefined || typeof block.thoughtSignature === 'string');
    }
    return block.type === 'tool_use'
      && typeof block.id === 'string'
      && typeof block.name === 'string'
      && 'args' in block;
  });
}

function isSessionUserBlocks(value: unknown): value is SessionUserBlock[] {
  return Array.isArray(value) && value.every((block) => (
    isContentPart(block)
      || isToolResultBlock(block)
      || isAttachmentBlock(block)
      || isSkillReferenceBlock(block)
  ));
}

function isAttachmentBlock(value: unknown): value is AttachmentBlock {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  if (value.type === 'image_reference') {
    return value.name === undefined || typeof value.name === 'string';
  }
  if (value.type === 'pasted_text_reference') {
    return typeof value.preview === 'string';
  }
  return value.type === 'file_reference';
}

function isSkillReferenceBlock(value: unknown): value is SkillReferenceBlock {
  return isRecord(value)
    && value.type === 'skill_reference'
    && typeof value.name === 'string'
    && typeof value.path === 'string';
}

function isToolResultBlock(value: unknown): value is ToolResult {
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

function isContentPart(value: unknown): value is ContentPart {
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
