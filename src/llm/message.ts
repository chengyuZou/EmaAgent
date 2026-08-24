// 定义单次语言模型调用使用的不可变消息，不承载 Session 持久化或界面展示字段。
import type { LlmGenerationSource } from './types.js';

/** Provider 可以接收的用户输入内容。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; name?: string; width?: number; height?: number }
  | { type: 'image_data'; data: string; mimeType: string; name?: string; width?: number; height?: number }
  | { type: 'audio_data'; data: string; mimeType: string; name?: string; durationMs?: number }
  | { type: 'file_data'; data: string; mimeType: string; filename?: string; pageCount?: number }
  | { type: 'file_url'; url: string; mimeType: string; filename?: string; pageCount?: number };

/**
 * Provider 返回并可能在下一次调用中继续使用的助手内容。推理内容按协议判别联合：
 * thinking（Anthropic signature）、reasoning（OpenAI Responses item id/encrypted）、
 * gemini_thought（Gemini thoughtSignature）各自携带原生续接状态；Adapter 只重放
 * 与自身协议匹配的变体，跨协议一律忽略。
 */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'reasoning'; id: string; summaryText?: string; encryptedContent?: string }
  | { type: 'gemini_thought'; text: string; thoughtSignature?: string };

/** Tool Result 能回传给模型的媒体范围比普通用户输入更窄。 */
export type ToolResultContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_data'; data: string; mimeType: string; width?: number; height?: number }
  | { type: 'image_url'; url: string; width?: number; height?: number };

/** 只描述模型可见的 Tool Result，不包含 UI presentation、耗时或持久化元数据。 */
export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string | readonly ToolResultContentPart[];
  isError?: boolean;
}

export type UserBlock = ContentPart | ToolResultBlock;

/**
 * LLM 模块的标准消息。
 *
 * Adapter 只能把该结构翻译为 Provider SDK 请求，不能接收 Session Message 或前端 Wire。
 * Tool Result 采用 user 内容块，避免把某一家 Provider 的 `role: tool` 变成领域模型。
 */
export type Message =
  | { role: 'system'; content: string; cacheBreakpoint?: true }
  | { role: 'user'; content: string | readonly UserBlock[]; cacheBreakpoint?: true }
  | {
      role: 'assistant';
      content: readonly AssistantBlock[];
      cacheBreakpoint?: true;
      /**
       * 中立执行元数据：这条 Assistant 历史由哪个调用目标生成。Adapter 编码厂商
       * Wire 消息时消费并剥除，绝不序列化进厂商请求；只对模型生成的 Assistant
       * 历史有意义，user/tool/reminder/summary 不伪造。
       */
      generatedBy?: LlmGenerationSource;
    };
