import type { NarrativeBridgeQuery, NarrativeBridgeResult } from "@ema-agent/core-types"

export interface NarrativeApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

export function createNarrativeApiClient(options: NarrativeApiClientOptions = {}) {
  const apiBaseUrl = options.apiBaseUrl?.replace(/\/+$/, "") ?? ""
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async health(): Promise<{ ok: boolean; message?: string }> {
      return requestJson(fetchLike, `${apiBaseUrl}/api/narrative/health`)
    },

    async query(input: NarrativeBridgeQuery): Promise<NarrativeBridgeResult> {
      return requestJson(fetchLike, `${apiBaseUrl}/api/narrative/query`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
    },
  }
}

async function requestJson<T>(fetchLike: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchLike(url, init)
  const text = await response.text()
  const data = text ? JSON.parse(text) as T : {} as T
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return data
}
