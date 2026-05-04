import { createHash, randomUUID } from "node:crypto"

import { asId } from "@ema-agent/core-types"
import type { AttachmentId, SessionId } from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

export interface IngestAttachmentInput {
  sessionId: SessionId
  fileName: string
  mime: string
  data: Buffer
}

export interface AttachmentProcessorOptions {
  chunkSize?: number
  chunkOverlap?: number
}

/**
 * 附件处理器。
 *
 * V1 先处理文本类附件：上传后解析为纯文本，再按固定窗口分块写入 SQLite。
 * PDF/Office/图片 OCR 后续交给 Python bridge 或专用解析库，不在这里硬写。
 */
export class AttachmentProcessor {
  constructor(
    private readonly storage: SqliteStorage,
    private readonly options: AttachmentProcessorOptions = {},
  ) {}

  async ingest(input: IngestAttachmentInput) {
    const attachmentId = asId<AttachmentId>(`att_${randomUUID()}`)
    const digest = sha256(input.data)

    const attachment = await this.storage.attachments.createAttachment({
      id: attachmentId,
      sessionId: input.sessionId,
      fileName: input.fileName,
      mime: input.mime,
      sizeBytes: input.data.byteLength,
      sha256: digest,
      status: "uploaded",
    })

    try {
      const text = parseAttachmentText(input.mime, input.data)
      const chunks = chunkText(text, {
        chunkSize: this.options.chunkSize ?? 1_600,
        chunkOverlap: this.options.chunkOverlap ?? 160,
      })

      await this.storage.attachments.replaceChunks(attachmentId, chunks.map((chunk, index) => ({
        id: `${attachmentId}_chunk_${index}`,
        attachmentId,
        sessionId: input.sessionId,
        chunkIndex: index,
        text: chunk,
        tokenCount: estimateTokens(chunk),
      })))
      await this.storage.attachments.updateStatus({
        attachmentId,
        status: "indexed",
        textPreview: text.slice(0, 240),
      })

      return {
        ...attachment,
        status: "indexed" as const,
        textPreview: text.slice(0, 240),
      }
    } catch (error) {
      await this.storage.attachments.updateStatus({
        attachmentId,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  recall(sessionId: SessionId, query: string, limit = 5) {
    return this.storage.attachments.recall(sessionId, query, limit)
  }
}

export function parseAttachmentText(mime: string, data: Buffer): string {
  if (isTextMime(mime)) {
    return data.toString("utf8")
  }
  throw new Error(`暂不支持解析此附件类型：${mime}`)
}

export function chunkText(text: string, options: { chunkSize: number; chunkOverlap: number }): string[] {
  const chunks: string[] = []
  const step = Math.max(1, options.chunkSize - options.chunkOverlap)

  for (let start = 0; start < text.length; start += step) {
    const chunk = text.slice(start, start + options.chunkSize).trim()
    if (chunk) {
      chunks.push(chunk)
    }
  }

  return chunks
}

function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || [
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "application/javascript",
  ].includes(mime)
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}
