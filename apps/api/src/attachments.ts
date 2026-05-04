import type { FastifyInstance } from "fastify"

import { AttachmentProcessor } from "@ema-agent/attachment"
import { EmaError, asId } from "@ema-agent/core-types"
import type { SessionId } from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

interface AttachmentRouteOptions {
  storage: SqliteStorage
}

interface UploadAttachmentBody {
  sessionId?: string
  fileName?: string
  mime?: string
  /** base64 编码的文件内容；桌面端后续可以换成本地文件路径/流式上传。 */
  base64?: string
}

interface SessionAttachmentParams {
  sessionId: string
}

interface RecallQuery {
  q?: string
  limit?: string
}

/**
 * Attachment API。
 *
 * 当前先用 JSON + base64 跑通桌面侧闭环；真实大文件上传后续再换 multipart 或 Tauri 文件句柄。
 */
export function registerAttachmentRoutes(app: FastifyInstance, options: AttachmentRouteOptions): void {
  const processor = new AttachmentProcessor(options.storage)

  app.post<{ Body: UploadAttachmentBody }>("/api/attachments", async (request) => {
    const input = normalizeUploadBody(request.body)
    return processor.ingest(input)
  })

  app.get<{ Params: SessionAttachmentParams }>("/api/sessions/:sessionId/attachments", async (request) => {
    return {
      items: await options.storage.attachments.listBySession(asId<SessionId>(request.params.sessionId)),
    }
  })

  app.get<{ Params: SessionAttachmentParams; Querystring: RecallQuery }>("/api/sessions/:sessionId/attachments/recall", async (request) => {
    const query = request.query.q?.trim()
    if (!query) {
      throw new EmaError("bad_request", "q 是必填召回关键词。", false)
    }

    return {
      items: await processor.recall(
        asId<SessionId>(request.params.sessionId),
        query,
        Number(request.query.limit ?? 5),
      ),
    }
  })
}

function normalizeUploadBody(body: UploadAttachmentBody) {
  if (!body.sessionId || !body.fileName || !body.mime || !body.base64) {
    throw new EmaError("bad_request", "sessionId、fileName、mime、base64 都是上传附件必填项。", false)
  }

  return {
    sessionId: asId<SessionId>(body.sessionId),
    fileName: body.fileName,
    mime: body.mime,
    data: Buffer.from(body.base64, "base64"),
  }
}
