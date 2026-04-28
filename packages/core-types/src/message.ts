/**
 * 前端聊天流消息协议。
 *
 * "一切皆区块"设计：每条消息由有序的 MessageContentBlock 组成，
 * 前端按顺序 map 渲染即可，无需正则解析。
 */
import type { ArtifactSummary } from "./artifact.js";
import type { ArtifactId, AttachmentId, MessageId, RequestId, ToolCallId, UnixMs } from "./ids.js"

// ==========================================
// 消息正文块（Discriminated Union）
// ==========================================

/**
 * 消息内容块——前端渲染的原子单位。
 *
 * 新增块类型只需在此联合类型中追加，所有消费方（渲染器、SSE、持久化）
 * 自动获得类型检查。
 */
export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; mimeType?: string; alt?: string }
  | { type: "attachment_ref"; attachmentId: AttachmentId }
  | { type: "artifact_ref"; artifact: ArtifactSummary }
  | {
      type: "tool_call"
      toolCallId: ToolCallId
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: "tool_result"
      toolCallId: ToolCallId
      toolName: string
      success: boolean
      resultStr: string
      durationMs: number
    }
  | {
      type: "permission_request"
      toolCallId: ToolCallId
      toolName: string
      /** 需要用户确认的操作摘要。 */
      summary: string
      /** 风险级别，前端据此改变确认按钮颜色。 */
      risk: "low" | "medium" | "high"
    }
  | {
      type: "error"
      code: string
      message: string
    }

// ==========================================
// 消息实体
// ==========================================

/** 消息角色。 */
export type MessageRole = "user" | "assistant" | "system"

/** 消息在客户端可见 UI 的瞬时进度状态。 */
export type MessageStatus = "sending" | "generating" | "complete" | "error"

/**
 * 统一的消息体——所有历史记录读写的中心单元。
 */
export interface ChatMessage {
  id: MessageId
  role: MessageRole

  /**
   * 强结构化的正文块列表。
   * 前端按索引顺序渲染，不再把工具调用、产物引用硬塞成纯字符串。
   */
  contentBlocks: MessageContentBlock[]

  /** 关联的 Turn Request ID，便于日志和重试追踪。 */
  requestId?: RequestId

  /** 界面展现使用的实时状态指示器。 */
  status: MessageStatus

  /** status === "error" 时的错误码。 */
  errorCode?: string

  createdAt: UnixMs
}

// ==========================================
// 分页
// ==========================================

export interface ListMessagesOptions {
  limit?: number
  /** 游标分页：传入当前最早消息 ID，查询更旧的消息。 */
  beforeMessageId?: MessageId
  /** 是否包含 system 消息（默认 false）。 */
  includeSystem?: boolean
}

export interface MessagePage {
  items: ChatMessage[]
  hasMore: boolean
  /** 下次分页使用的 beforeMessageId。 */
  nextBeforeMessageId?: MessageId
}