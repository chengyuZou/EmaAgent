import type { AttachmentId, SessionId, UnixMs } from "./ids.js"

export type AttachmentStatus = "uploaded" | "parsed" | "indexed" | "failed"

export interface AttachmentRecord {
  id: AttachmentId
  sessionId: SessionId
  fileName: string
  mime: string
  sizeBytes: number
  sha256: string
  status: AttachmentStatus
  textPreview?: string
  errorMessage?: string
  createdAt: UnixMs
  updatedAt: UnixMs
}

export interface AttachmentChunk {
  id: string
  attachmentId: AttachmentId
  sessionId: SessionId
  chunkIndex: number
  text: string
  tokenCount: number
  createdAt: UnixMs
}

export interface AttachmentRecallHit {
  attachment: AttachmentRecord
  chunk: AttachmentChunk
  score: number
}
