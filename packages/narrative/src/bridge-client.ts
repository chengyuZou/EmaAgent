import type { NarrativeBridgeQuery, NarrativeBridgeResult } from "@ema-agent/core-types"

export interface NarrativeBridgeClientOptions {
  baseUrl?: string
  token?: string
  fetch?: typeof fetch
}

/**
 * Python narrative bridge 客户端。
 *
 * LightRAG 和剧情语料仍在 Python 侧；TS 只负责发请求、归一化结果和失败降级。
 */
export class NarrativeBridgeClient {
  private readonly baseUrl: string
  private readonly fetchLike: typeof fetch

  constructor(private readonly options: NarrativeBridgeClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "http://127.0.0.1:8766"
    this.fetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await this.fetchLike(`${this.baseUrl}/health`, { headers: this.headers() })
      return { ok: response.ok, message: response.ok ? undefined : `HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async query(input: NarrativeBridgeQuery): Promise<NarrativeBridgeResult> {
    try {
      const response = await this.fetchLike(`${this.baseUrl}/narrative/query`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.headers(),
        },
        body: JSON.stringify(input),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return JSON.parse(text) as NarrativeBridgeResult
    } catch {
      return {
        chunks: [],
        deduped: true,
        durationMs: 0,
      }
    }
  }

  private headers(): Record<string, string> {
    return this.options.token ? { "x-ema-bridge-token": this.options.token } : {}
  }
}

export function narrativeResultToContext(result: NarrativeBridgeResult): string {
  return result.chunks
    .map((chunk) => `[${chunk.source} relevance=${chunk.relevance.toFixed(2)}]\n${chunk.text}`)
    .join("\n\n")
    .trim()
}
