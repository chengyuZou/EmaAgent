export interface TelemetryApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

export interface TelemetryEventView {
  id: string
  traceId?: string
  requestId?: string
  sessionId?: string
  type: string
  level: "debug" | "info" | "warn" | "error"
  payload: Record<string, unknown>
  createdAt: number
}

export function createTelemetryApiClient(options: TelemetryApiClientOptions = {}) {
  const apiBaseUrl = options.apiBaseUrl?.replace(/\/+$/, "") ?? ""
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async listRecent(limit = 50): Promise<TelemetryEventView[]> {
      const response = await requestJson<{ items: TelemetryEventView[] }>(fetchLike, `${apiBaseUrl}/api/telemetry/events?limit=${limit}`)
      return response.items
    },

    async listByRequest(requestId: string): Promise<TelemetryEventView[]> {
      const response = await requestJson<{ items: TelemetryEventView[] }>(fetchLike, `${apiBaseUrl}/api/telemetry/events?requestId=${encodeURIComponent(requestId)}`)
      return response.items
    },
  }
}

async function requestJson<T>(fetchLike: typeof fetch, url: string): Promise<T> {
  const response = await fetchLike(url)
  const text = await response.text()
  const data = text ? JSON.parse(text) as T : {} as T
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return data
}
