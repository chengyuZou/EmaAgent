import type { ArtifactDetail, ArtifactKind, ArtifactPage, ArtifactParams, ArtifactStatus } from "@ema-agent/core-types"

export interface ArtifactApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

export interface CreateArtifactRequest {
  sessionId: string
  requestId: string
  kind: ArtifactKind
  title: string
  description?: string
  mime?: string
  targetPaths?: string[]
  params?: ArtifactParams
  status?: ArtifactStatus
  content?: string
}

/**
 * Workspace/Artifact API client。
 *
 * UI 层不直接 fetch，统一走这里，方便后面加缓存、错误码和 Tauri IPC。
 */
export function createArtifactApiClient(options: ArtifactApiClientOptions = {}) {
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl)
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async listBySession(sessionId: string): Promise<ArtifactPage> {
      return requestJson(fetchLike, `${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/artifacts`)
    },

    async getArtifact(artifactId: string): Promise<ArtifactDetail> {
      return requestJson(fetchLike, `${apiBaseUrl}/api/artifacts/${encodeURIComponent(artifactId)}`)
    },

    async createArtifact(input: CreateArtifactRequest) {
      return requestJson(fetchLike, `${apiBaseUrl}/api/artifacts`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(input),
      })
    },

    async applyArtifact(artifactId: string, expectedSha256ByPath: Record<string, string> = {}) {
      return requestJson(fetchLike, `${apiBaseUrl}/api/artifacts/${encodeURIComponent(artifactId)}/apply`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ expectedSha256ByPath }),
      })
    },

    async rejectArtifact(artifactId: string) {
      return requestJson(fetchLike, `${apiBaseUrl}/api/artifacts/${encodeURIComponent(artifactId)}/reject`, {
        method: "POST",
      })
    },
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  return value ? value.replace(/\/+$/, "") : ""
}

function jsonHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
}

async function requestJson<T>(fetchLike: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchLike(url, init)
  const text = await response.text()
  const data = text ? JSON.parse(text) as T : {} as T

  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message: unknown }).message)
      : `HTTP ${response.status}`
    throw new Error(message)
  }

  return data
}
