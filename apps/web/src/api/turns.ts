import type { StartTurnRequest, StartTurnResponse } from "@ema-agent/core-types"

export interface TurnApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

/**
 * Turn API client。
 *
 * 前端发消息时只需要调用 startTurn()，拿到 streamUrl 后交给 useTurnStream。
 */
export function createTurnApiClient(options: TurnApiClientOptions = {}) {
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl)
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async startTurn(input: StartTurnRequest): Promise<StartTurnResponse> {
      const response = await fetchLike(`${apiBaseUrl}/api/turns`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
      const data = await response.json() as StartTurnResponse | { message?: string }

      if (!response.ok) {
        throw new Error("message" in data && data.message ? data.message : `HTTP ${response.status}`)
      }

      return data as StartTurnResponse
    },
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  return value ? value.replace(/\/+$/, "") : ""
}
