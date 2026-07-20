// 这里定义会话消息、工具调用结果和客户端展示数据的公共契约。

// ── 消息分类 ──────────────────────────────────────────────────────────────────
// 从 ids.ts 迁移过来：MessageKind 描述一条消息的"用途"，属于消息语义，不属于 ID

/**
 * 决定一条消息如何被 LLM 使用 和 如何在 UI 里渲染：
 *
 * | kind              | 发给 LLM? | UI 渲染?            |
 * |-------------------|-----------|---------------------|
 * | normal            | ✅        | ✅ 正常气泡          |
 * | summary           | ✅        | ✅ "上下文已压缩"横幅 |
 * | context           | ✅        | ❌ 隐藏              |
 * | tool_results      | ✅        | ❌ 合并进助手气泡    |
 * | persona_reminder  | ✅        | ❌ 隐藏              |
 * | narrative_context | ✅        | ✅ narrative 检索块气泡 |
 */
export type MessageKind =
  | 'normal'
  | 'context'
  | 'tool_results'
  | 'summary'
  | 'persona_reminder'
  | 'narrative_context';

// ── narrative 检索结果(narrative_context kind 的 blocks 结构)──────────────────

/**
 * narrative 模式 beforeLlm hook 检索到的单条剧情线结果。
 * 落盘进 messages.blocks_json,既回灌 LLM(转 [NARRATIVE CONTEXT] 文本)
 * 又在前端 NarrativeStatusBlock 展开显示完整 text。
 */
export interface NarrativeTimelineRecall {
  /** 剧情线名,如 '1st_Loop' / '2nd_Loop' / '3rd_Loop' */
  name:      string;
  /** 检索文本字符数(展示用,避免前端算长度) */
  charCount: number;
  /** 完整检索文本(展开看 + 回灌 LLM 用) */
  text:      string;
}

/**
 * kind='narrative_context' message 的 blocks 结构。
 * MessageBlocks 是 string | AssistantBlock[] | UserBlock[],这里再加一种对象形态 --
 * narrative_context 的 blocks 是此对象,JSON 存进 blocks_json。
 */
export interface NarrativeContextBlocks {
  timelines: NarrativeTimelineRecall[];
}

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
  | { type: 'image_url';  url: string;  name?: string; width?: number; height?: number }
  | { type: 'image_data'; data: string; mimeType: string; name?: string; width?: number; height?: number }
  | { type: 'audio_data'; data: string; mimeType: string; name?: string; durationMs?: number }
  | { type: 'file_data';  data: string; mimeType: string; filename?: string; pageCount?: number }
  | { type: 'file_url';   url: string;  mimeType: string; filename?: string; pageCount?: number };

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
  | { type: 'image_data'; data: string; mimeType: string; width?: number; height?: number }
  | { type: 'image_url';  url: string; width?: number; height?: number };

/** 文件工具提交成功后给界面使用的有界真实变更；不会作为模型上下文正文发送。 */
export interface FileChangePresentation {
  kind: 'file_change';
  operation: 'create' | 'update';
  filePath: string;
  unifiedDiff: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** 文件过大时不计算完整 diff，客户端显示这个原因。 */
  omittedReason?: string;
}

export type ToolPresentation = FileChangePresentation;

export interface ToolResultBlock {
  type:      'tool_result';
  toolUseId: string;
  content:   string | ToolResultContentPart[];
  isError?:  boolean;
  /** 工具执行耗时（ms）。刷新后从 DB 还原，让 Tool 块能持续显示耗时。 */
  durationMs?: number;
  /** 失败原因精确码：'permission/denied' | 'policy/denied' | 'tool/error'。成功时 undefined。 */
  errorCode?:  string;
  /** 仅供客户端展示的结构化结果，与发给模型的 content 分离。 */
  presentation?: ToolPresentation;
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
export type MessageBlocks = string | AssistantBlock[] | UserBlock[] | NarrativeContextBlocks;

// ── 附件元数据（UI 展示用） ───────────────────────────────────────────────────

/**
 * 附件的显示信息，与 MessageContentPart 分离：
 * - MessageContentPart 是发给 LLM 的实际内容
 * - TurnAttachment 是 UI 渲染用的元数据（文件名、能力句柄、大小）
 *
 * 存在 turn_attachments 表里（per-turn，独立于 messages 表），
 * UI 上渲染在 role='user' 的消息上。
 */
export interface TurnAttachment {
  id:         string;   // 对应 MessageContentPart 的稳定 id（前端关联用）
  name:       string;   // 显示名：'cat.png' / 'main.py' / '粘贴的文字'
  mimeType:   string;
  size?:      number;   // 字节数，用于显示 '2.3 MB'
  mtime?:     number;   // 文件修改时间（unix ms）；Tool 用来检测文件是否在附件后被修改
  fileHandle?: string | null; // 由桌面宿主签发；前端不能据此构造其他本机路径
}

// ── HTTP API 响应格式 ─────────────────────────────────────────────────────────

// MessageWire 已移至 wire.ts —— 所有 REST wire 类型统一放在那里。
