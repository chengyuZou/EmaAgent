/**
 * 前端聊天流消息协议。
 *
 * ## "一切皆区块"设计
 *
 * 每条消息由有序的 `MessageContentBlock[]` 组成。前端按索引顺序 map 渲染，
 * 无需正则解析、无需从纯文本中提取工具调用或产物引用。
 *
 * 新增块类型只需在 `MessageContentBlock` 联合类型中追加，
 * 所有消费方（React 渲染器、SSE 持久化、search）自动获得 exhaustiveness check。
 */

import type { ArtifactSummary } from "./artifact.js"
import type { AttachmentId, MessageId, RequestId, ToolCallId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 消息正文块（Discriminated Union）
// ═══════════════════════════════════════════════════════════════

/**
 * 消息内容块——前端渲染的原子单位。
 *
 * @example
 * // 前端按索引顺序渲染
 * message.contentBlocks.map(block => {
 *   switch (block.type) {
 *     case "text": return <TextBlock text={block.text} />
 *     case "tool_call": return <ToolCallCard {...block} />
 *     // ... TypeScript 会提示是否有遗漏的 case
 *   }
 * })
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
      /** 人类可读的操作摘要——前端确认弹窗的正文。 */
      summary: string
      /** 风险级别——前端据此改变确认按钮的颜色和文案。 */
      risk: "low" | "medium" | "high" | "critical"
    }
  | {
      type: "step"
      stepId: string
      detail: string
    }
  | {
      type: "retrieval"
      source: string
      content: string
    }
  | {
      type: "compression"
      originalTokens: number
      compressedTokens: number
      content: string
    }
  | {
      type: "error"
      code: string
      message: string
    }

// ═══════════════════════════════════════════════════════════════
// 消息实体
// ═══════════════════════════════════════════════════════════════

/** 消息角色。 */
export type MessageRole = "user" | "assistant" | "system"

/** 消息在客户端 UI 的瞬时进度状态——前端据此显示 loading/error 动画。 */
export type MessageStatus = "sending" | "generating" | "complete" | "error"

/**
 * 统一的消息体——所有历史记录读写的中心单元。
 *
 * @example
 * // 创建一条用户消息
 * const userMsg: ChatMessage = {
 *   id: asId<MessageId>("msg_001"),
 *   role: "user",
 *   contentBlocks: [{ type: "text", text: "帮我找个文件" }],
 *   status: "complete",
 *   createdAt: Date.now(),
 * }
 */
export interface ChatMessage {
  id: MessageId
  role: MessageRole

  /**
   * 强结构化的正文块列表。
   * 前端按索引顺序渲染，不再把工具调用、产物引用硬塞成纯字符串。
   */
  contentBlocks: MessageContentBlock[]

  /** 关联的 Turn Request ID——便于日志追踪和重试定位。 */
  requestId?: RequestId

  /** 界面展现使用的实时状态指示器。 */
  status: MessageStatus

  /** status === "error" 时的稳定错误码。 */
  errorCode?: string

  createdAt: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 分页
// ═══════════════════════════════════════════════════════════════

export interface ListMessagesOptions {
  limit?: number
  /** 游标分页——传入当前最早消息 ID，查询更旧的消息（倒序加载历史）。 */
  beforeMessageId?: MessageId
  /** 是否包含 system 消息（默认 false）。 */
  includeSystem?: boolean
}

export interface MessagePage {
  items: ChatMessage[]
  hasMore: boolean
  /** 下一次分页使用的 beforeMessageId——客户端传递此值实现连续下滑加载。 */
  nextBeforeMessageId?: MessageId
}
