import type { LLMGenerationSource, LLMThinkingState } from './types.js';

/** 用户输入的文本和媒体. 具体协议能否表达这些内容由 protocolInput 检查. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; name?: string; width?: number; height?: number }
  | { type: 'image_data'; data: string; mimeType: string; name?: string; width?: number; height?: number }
  | { type: 'audio_data'; data: string; mimeType: string; name?: string; durationMs?: number }
  | { type: 'file_data'; data: string; mimeType: string; filename?: string; pageCount?: number }
  | { type: 'file_url'; url: string; mimeType: string; filename?: string; pageCount?: number };

/**
 * 原生思考状态分别保存在 thinking, reasoning 和 gemini_thought 中.
 * 协议转换时还会检查 generatedBy, 不向不同生成目标回传这些状态.
 */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'reasoning'; id: string; summaryText?: string; encryptedContent?: string }
  | { type: 'gemini_thought'; text: string; thoughtSignature?: string };

/** 工具结果包含文本或图片, 不接受普通用户输入中的音频和文件块. */
export type ToolResultContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_data'; data: string; mimeType: string; width?: number; height?: number }
  | { type: 'image_url'; url: string; width?: number; height?: number };

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string | readonly ToolResultContentPart[];
  isError?: boolean;
}

export type UserBlock = ContentPart | ToolResultBlock;

/**
 * 工具回复放在 user 内容中, 协议实现再转换成各供应商要求的角色和结构.
 * cacheBreakpoint 只在 Anthropic 请求中转换为缓存标记, 其他协议忽略它.
 */
export type Message =
  | { role: 'system'; content: string; cacheBreakpoint?: true }
  | { role: 'user'; content: string | readonly UserBlock[]; cacheBreakpoint?: true }
  | {
      role: 'assistant';
      content: readonly AssistantBlock[];
      cacheBreakpoint?: true;
      /**
       * 缺失或与当前 providerId, modelId, protocol 不一致时, 不回传原生思考状态.
       * 普通正文和工具调用仍保留, 不因此删除整条助手消息.
       */
      generatedBy?: LLMGenerationSource;
    };

/**
 * 将思考文本和原生状态合成历史消息中的内容块.
 * OpenAI 可以只返回 reasoning ID 而没有摘要文本, 此时仍保留原生状态.
 * Anthropic 和 Gemini 没有思考文本时不创建空内容块.
 */
export function createAssistantThinkingBlock(
  thinking: string | undefined,
  state: LLMThinkingState | undefined,
): AssistantBlock | undefined {
  if (state?.kind === 'openai') {
    return {
      type: 'reasoning',
      id: state.id,
      ...(thinking ? { summaryText: thinking } : {}),
      ...(state.encryptedContent ? { encryptedContent: state.encryptedContent } : {}),
    };
  }
  if (thinking === undefined) return undefined;
  if (state?.kind === 'gemini') {
    return {
      type: 'gemini_thought',
      text: thinking,
      ...(state.thoughtSignature ? { thoughtSignature: state.thoughtSignature } : {}),
    };
  }
  return {
    type: 'thinking',
    thinking,
    ...(state?.kind === 'anthropic' && state.signature
      ? { signature: state.signature }
      : {}),
  };
}
