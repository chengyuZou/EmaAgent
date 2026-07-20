// 定义单次语言模型调用使用的不可变消息，不承载 Session 持久化或界面展示字段。

/** Provider 可以接收的用户输入内容。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; name?: string; width?: number; height?: number }
  | { type: 'image_data'; data: string; mimeType: string; name?: string; width?: number; height?: number }
  | { type: 'audio_data'; data: string; mimeType: string; name?: string; durationMs?: number }
  | { type: 'file_data'; data: string; mimeType: string; filename?: string; pageCount?: number }
  | { type: 'file_url'; url: string; mimeType: string; filename?: string; pageCount?: number };

/** Provider 返回并可能在下一次调用中继续使用的助手内容。 */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown };

/** Tool Result 能回传给模型的媒体范围比普通用户输入更窄。 */
export type ToolResultContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_data'; data: string; mimeType: string; width?: number; height?: number }
  | { type: 'image_url'; url: string; width?: number; height?: number };

/** 只描述模型可见的 Tool Result，不包含 UI presentation、耗时或持久化元数据。 */
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string | ToolResultContentPart[];
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
  | { role: 'user'; content: string | UserBlock[]; cacheBreakpoint?: true }
  | { role: 'assistant'; content: AssistantBlock[]; cacheBreakpoint?: true };
