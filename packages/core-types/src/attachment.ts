/**
 * 附件协议——用户上传文件的生命周期类型。
 *
 * 附件经上传 → 解析 → chunk → 索引 → 召回五阶段流转。
 * 召回结果用于在 turn 上下文中注入附件相关片段。
 */

import type { AttachmentId, SessionId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 附件实体
// ═══════════════════════════════════════════════════════════════

/** 附件处理状态——前端据此显示"上传中/解析中/就绪/失败"标签。 */
export type AttachmentStatus = "uploaded" | "parsed" | "indexed" | "failed"

/** 附件持久化实体——`attachments` 表的类型投影。 */
export interface AttachmentRecord {
  id: AttachmentId
  sessionId: SessionId
  fileName: string
  mime: string
  sizeBytes: number
  /** SHA-256 哈希——用于去重和完整性校验。 */
  sha256: string
  status: AttachmentStatus
  textPreview?: string
  errorMessage?: string
  createdAt: UnixMs
  updatedAt: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 文本分块
// ═══════════════════════════════════════════════════════════════

/** 附件文本分块——检索的最小单位。 */
export interface AttachmentChunk {
  id: string
  attachmentId: AttachmentId
  sessionId: SessionId
  chunkIndex: number
  text: string
  tokenCount: number
  createdAt: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 召回
// ═══════════════════════════════════════════════════════════════

/** 附件召回的单个命中项——按语义相似度排序。 */
export interface AttachmentRecallHit {
  attachment: AttachmentRecord
  chunk: AttachmentChunk
  score: number
}
