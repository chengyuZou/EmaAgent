import type { ContextRadarView, WriteMemoryFactInput } from "@ema-agent/memory"

export interface MemoryApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

export function createMemoryApiClient(options: MemoryApiClientOptions = {}) {
  const apiBaseUrl = options.apiBaseUrl?.replace(/\/+$/, "") ?? ""
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async writeFact(input: WriteMemoryFactInput) {
      return requestJson(fetchLike, `${apiBaseUrl}/api/memory/facts`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(input),
      })
    },

    async getContextRadar(input: { sessionId: string; query: string; mode: string; maxTokens?: number }): Promise<ContextRadarView> {
      const params = new URLSearchParams({
        q: input.query,
        mode: input.mode,
      })
      if (input.maxTokens) {
        params.set("maxTokens", String(input.maxTokens))
      }
      return requestJson(fetchLike, `${apiBaseUrl}/api/sessions/${encodeURIComponent(input.sessionId)}/context-radar?${params.toString()}`)
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
