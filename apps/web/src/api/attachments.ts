import type { AttachmentRecallHit, AttachmentRecord } from "@ema-agent/core-types"

export interface AttachmentApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

export interface UploadAttachmentRequest {
  sessionId: string
  fileName: string
  mime: string
  base64: string
}

export function createAttachmentApiClient(options: AttachmentApiClientOptions = {}) {
  const apiBaseUrl = options.apiBaseUrl?.replace(/\/+$/, "") ?? ""
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async upload(input: UploadAttachmentRequest): Promise<AttachmentRecord> {
      return requestJson(fetchLike, `${apiBaseUrl}/api/attachments`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(input),
      })
    },

    async list(sessionId: string): Promise<AttachmentRecord[]> {
      const response = await requestJson<{ items: AttachmentRecord[] }>(
        fetchLike,
        `${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/attachments`,
      )
      return response.items
    },

    async recall(sessionId: string, query: string, limit = 5): Promise<AttachmentRecallHit[]> {
      const response = await requestJson<{ items: AttachmentRecallHit[] }>(
        fetchLike,
        `${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/attachments/recall?q=${encodeURIComponent(query)}&limit=${limit}`,
      )
      return response.items
    },
  }
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
    throw new Error(typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : `HTTP ${response.status}`)
  }
  return data
}
