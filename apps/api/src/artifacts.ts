import { randomUUID, createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { FastifyInstance } from "fastify"

import { EmaError, asId } from "@ema-agent/core-types"
import type {
  ArtifactId,
  ArtifactKind,
  ArtifactParams,
  ArtifactStatus,
  RequestId,
  SessionId,
} from "@ema-agent/core-types"
import { assertWriteAllowed, createWorkspaceScope, resolveWorkspacePath } from "@ema-agent/sandbox"
import type { SqliteStorage } from "@ema-agent/storage-sql"

interface ArtifactRouteOptions {
  storage: SqliteStorage
  workspaceRoot: string
}

interface SessionArtifactsParams {
  sessionId: string
}

interface ArtifactParamsRoute {
  artifactId: string
}

interface CreateArtifactBody {
  sessionId?: string
  requestId?: string
  kind?: ArtifactKind
  title?: string
  description?: string
  mime?: string
  targetPaths?: string[]
  params?: ArtifactParams
  status?: ArtifactStatus
  content?: string
}

interface ApplyArtifactBody {
  expectedSha256ByPath?: Record<string, string>
}

/**
 * Artifact / Workspace API。
 *
 * Artifact 是 Agent 产出的结构化文件、代码、图表或 diff。
 * 这里提供最小可用的 Workspace 后端：列表、详情、创建、采纳、拒绝。
 */
export function registerArtifactRoutes(app: FastifyInstance, options: ArtifactRouteOptions): void {
  app.get<{ Params: SessionArtifactsParams }>("/api/sessions/:sessionId/artifacts", async (request) => {
    const page = await options.storage.artifacts.listArtifactsBySession(asId<SessionId>(request.params.sessionId), {
      limit: 50,
    })
    return page
  })

  app.get<{ Params: ArtifactParamsRoute }>("/api/artifacts/:artifactId", async (request) => {
    const artifact = await options.storage.artifacts.getArtifactById(toArtifactId(request.params.artifactId))
    if (!artifact) {
      throw new EmaError("artifact_not_found", "Artifact 不存在。", false)
    }
    return artifact
  })

  app.post<{ Body: CreateArtifactBody }>("/api/artifacts", async (request) => {
    const input = normalizeCreateArtifactBody(request.body)
    return options.storage.artifacts.createArtifact({
      id: asId<ArtifactId>(`art_${randomUUID()}`),
      sessionId: input.sessionId,
      requestId: input.requestId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      mime: input.mime,
      targetPaths: input.targetPaths,
      params: input.params,
      status: input.status ?? "ready",
      payloadType: "inline",
      payloadContent: input.content ?? "",
      contentHash: sha256(Buffer.from(input.content ?? "", "utf8")),
    })
  })

  app.post<{ Params: ArtifactParamsRoute; Body: ApplyArtifactBody }>("/api/artifacts/:artifactId/apply", async (request) => {
    const result = await applyArtifact({
      storage: options.storage,
      workspaceRoot: options.workspaceRoot,
      artifactId: toArtifactId(request.params.artifactId),
      expectedSha256ByPath: request.body?.expectedSha256ByPath ?? {},
    })
    return result
  })

  app.post<{ Params: ArtifactParamsRoute }>("/api/artifacts/:artifactId/reject", async (request) => {
    await options.storage.artifacts.updateArtifact({
      artifactId: toArtifactId(request.params.artifactId),
      status: "rejected",
    })
    return { ok: true }
  })
}

async function applyArtifact(input: {
  storage: SqliteStorage
  workspaceRoot: string
  artifactId: ArtifactId
  expectedSha256ByPath: Record<string, string>
}): Promise<{ ok: true; written: Array<{ path: string; sha256: string; bytes: number }> }> {
  const artifact = await input.storage.artifacts.getArtifactById(input.artifactId)
  if (!artifact) {
    throw new EmaError("artifact_not_found", "Artifact 不存在。", false)
  }

  const targetPaths = artifact.summary.targetPaths ?? []
  if (targetPaths.length === 0) {
    throw new EmaError("bad_request", "Artifact 没有 targetPaths，不能 Apply 到工作区。", false)
  }

  if (artifact.summary.kind === "patch") {
    throw new EmaError("bad_request", "当前 Apply 只支持完整文件 Artifact，unified diff patch 会在后续 diff apply 中接入。", false)
  }

  const content = await readArtifactTextPayload(artifact.payload)
  const scope = createWorkspaceScope({
    rootDir: input.workspaceRoot,
    allowWrite: true,
  })
  assertWriteAllowed(scope)

  const written: Array<{ path: string; sha256: string; bytes: number }> = []
  for (const targetPath of targetPaths) {
    const fullPath = resolveWorkspacePath(scope, targetPath)
    const expectedSha256 = input.expectedSha256ByPath[targetPath]

    if (expectedSha256) {
      const current = await readFile(fullPath).catch(() => undefined)
      const currentHash = current ? sha256(current) : undefined
      if (currentHash !== expectedSha256) {
        throw new EmaError("sandbox_denied", `文件已变化，拒绝覆盖：${targetPath}`, false, {
          expectedSha256,
          currentHash,
        })
      }
    }

    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, "utf8")
    const buffer = Buffer.from(content, "utf8")
    written.push({
      path: targetPath,
      sha256: sha256(buffer),
      bytes: buffer.byteLength,
    })
  }

  await input.storage.artifacts.updateArtifact({
    artifactId: input.artifactId,
    status: "applied",
  })

  return { ok: true, written }
}

function normalizeCreateArtifactBody(body: CreateArtifactBody) {
  if (!body.sessionId || !body.requestId || !body.kind || !body.title) {
    throw new EmaError("bad_request", "sessionId、requestId、kind、title 是创建 Artifact 的必填项。", false)
  }

  return {
    sessionId: asId<SessionId>(body.sessionId),
    requestId: asId<RequestId>(body.requestId),
    kind: body.kind,
    title: body.title,
    description: body.description,
    mime: body.mime,
    targetPaths: body.targetPaths,
    params: body.params,
    status: body.status,
    content: body.content,
  }
}

async function readArtifactTextPayload(payload: { type: "inline"; content: string } | { type: "file"; path: string } | { type: "db"; key: string }): Promise<string> {
  if (payload.type === "inline") {
    return payload.content
  }
  if (payload.type === "file") {
    return readFile(payload.path, "utf8")
  }
  throw new EmaError("bad_request", "db payload 暂未支持直接 Apply。", false)
}

function toArtifactId(value: string): ArtifactId {
  return asId<ArtifactId>(value)
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}
