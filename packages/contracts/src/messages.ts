import type { MessageId, MessageRole } from './ids.js';

// ── 消息分类 ──────────────────────────────────────────────────────────────────
// 从 ids.ts 迁移过来：MessageKind 描述一条消息的"用途"，属于消息语义，不属于 ID

/**
 * 决定一条消息如何被 LLM 使用 和 如何在 UI 里渲染：
 *
 * | kind             | 发给 LLM? | UI 渲染?          |
 * |------------------|-----------|-------------------|
 * | normal           | ✅        | ✅ 正常气泡        |
 * | summary          | ✅        | ✅ "上下文已压缩"横幅 |
 * | context          | ✅        | ❌ 隐藏            |
 * | tool_results     | ✅        | ❌ 合并进助手气泡  |
 * | persona_reminder | ✅        | ❌ 隐藏            |
 * | compact_boundary | ❌        | ❌ 只是切割标记    |
 */
export type MessageKind =
  | 'normal'
  | 'context'
  | 'tool_results'
  | 'summary'
  | 'persona_reminder';

// ── 多模态内容块 ──────────────────────────────────────────────────────────────

/**
 * Provider support matrix:
 *
 * | type       | OpenAI | Anthropic | Gemini          |
 * |------------|--------|-----------|-----------------|
 * | text       | ✅     | ✅        | ✅              |
 * | image_url  | ✅     | ✅        | ⚠️ GCS only     |
 * | image_data | ✅     | ✅        | ✅              |
 * | audio_data | ✅ wav/mp3 | ❌   | ✅ multi-format |
 * | file_data  | ❌     | ✅ PDF    | ✅              |
 * | file_url   | ❌     | ✅ PDF    | ⚠️ GCS only     |
 *
 * `name` 字段用于 UI 显示文件名（图片/音频本身没有 filename，需要显式传入）
 */
export type MessageContentPart =
  | { type: 'text';       text: string }
  | { type: 'image_url';  url: string;  name?: string }
  | { type: 'image_data'; data: string; mimeType: string; name?: string }
  | { type: 'audio_data'; data: string; mimeType: string; name?: string }
  | { type: 'file_data';  data: string; mimeType: string; filename?: string }
  | { type: 'file_url';   url: string;  mimeType: string; filename?: string };

// ── 助手消息 block ────────────────────────────────────────────────────────────

export type AssistantBlock =
  | { type: 'text';     text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown };

// ── 工具结果 block ────────────────────────────────────────────────────────────

/**
 * tool_result 的 content 比 MessageContentPart 窄：
 * Anthropic 只接受 text 和 image，不接受 audio/file。
 */
export type ToolResultContentPart =
  | { type: 'text';       text: string }
  | { type: 'image_data'; data: string; mimeType: string }
  | { type: 'image_url';  url: string };

export interface ToolResultBlock {
  type:      'tool_result';
  toolUseId: string;
  content:   string | ToolResultContentPart[];
  isError?:  boolean;
}

// ── 用户消息 block ────────────────────────────────────────────────────────────

export type UserBlock = MessageContentPart | ToolResultBlock;

// ── 存储格式 ──────────────────────────────────────────────────────────────────

/**
 * blocks_json 列的解析规则：
 *   string          → 纯文本（system 消息或简单 user 文字）
 *   AssistantBlock[] → role='assistant'
 *   UserBlock[]     → role='user'（含多模态或 tool_result）
 */
export type MessageBlocks = string | AssistantBlock[] | UserBlock[];

// ── 附件元数据（UI 展示用） ───────────────────────────────────────────────────

/**
 * 附件的显示信息，与 MessageContentPart 分离：
 * - MessageContentPart 是发给 LLM 的实际内容
 * - TurnAttachment 是 UI 渲染用的元数据（文件名、本地路径、大小）
 *
 * 存在 messages.attachments_json 列里，
 * 只出现在 role='user' 的消息上。
 */
export interface TurnAttachment {
  id:         string;   // 对应 MessageContentPart 的稳定 id（前端关联用）
  name:       string;   // 显示名：'cat.png' / 'main.py' / '粘贴的文字'
  mimeType:   string;
  size?:      number;   // 字节数，用于显示 '2.3 MB'
  localPath?: string;   // 本机绝对路径，用于点击打开（单机应用）
}

// ── HTTP API 响应格式 ─────────────────────────────────────────────────────────

/**
 * GET /api/sessions/:id/messages 的单条响应体。
 *
 * 前端根据 kind 决定渲染方式（见 MessageKind 表格）。
 * tool_results 消息不单独渲染气泡，前端用 toolUseId 把结果合并进
 * 对应的 assistant 气泡里的 tool_use block。
 */
export interface MessageWire {
  id:           MessageId;
  role:         MessageRole;
  kind:         MessageKind;
  blocks:       MessageBlocks;
  attachments?: TurnAttachment[];  // 只在 role='user' 消息上有值
  meta:        Record<string, unknown>; // 用于 kind='summary' 的压缩元信息，或其他扩展字段
  createdAt:    number;
}