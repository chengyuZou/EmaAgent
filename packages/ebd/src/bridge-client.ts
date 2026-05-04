import { createHash } from "node:crypto"

import type { EbdBridgeHealth, EmbedRequest, EmbedResponse, RerankRequest, RerankResponse } from "./types.js"

export interface EbdBridgeClientOptions {
  baseUrl?: string
  token?: string
  fetch?: typeof fetch
  fallbackModelId?: string
}

/**
 * Python bridge 客户端。
 *
 * TS 主进程不直接加载 Python 模型，只通过 HTTP bridge 调 embed/rerank。
 * 如果 bridge 未启动，V1 先降级到确定性 fallback，保证调用方不会阻塞主链路。
 */
export class EbdBridgeClient {
  private readonly baseUrl: string
  private readonly fetchLike: typeof fetch
  private readonly fallbackModelId: string

  constructor(private readonly options: EbdBridgeClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "http://127.0.0.1:8765"
    this.fetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.fallbackModelId = options.fallbackModelId ?? "local-hash-embedding"
  }

  async health(): Promise<EbdBridgeHealth> {
    try {
      const response = await this.fetchLike(`${this.baseUrl}/health`, {
        headers: this.headers(),
      })
      if (!response.ok) {
        return { ok: false, status: "down", message: `HTTP ${response.status}` }
      }
      return { ok: true, status: "ok" }
    } catch (error) {
      return {
        ok: false,
        status: "fallback",
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    try {
      return await this.requestJson<EmbedResponse>("/embed", input)
    } catch {
      return fallbackEmbed(input, this.fallbackModelId)
    }
  }

  async rerank(input: RerankRequest): Promise<RerankResponse> {
    try {
      return await this.requestJson<RerankResponse>("/rerank", input)
    } catch {
      return fallbackRerank(input, this.fallbackModelId)
    }
  }

  private async requestJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchLike(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.headers(),
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) as T : {} as T
    if (!response.ok) {
      throw new Error(`Python bridge ${path} failed: HTTP ${response.status}`)
    }
    return data
  }

  private headers(): Record<string, string> {
    return this.options.token ? { "x-ema-bridge-token": this.options.token } : {}
  }
}

function fallbackEmbed(input: EmbedRequest, modelId: string): EmbedResponse {
  const texts = Array.isArray(input.input) ? input.input : [input.input]
  const embeddings = texts.map((text) => hashVector(text, 64))
  return {
    embeddings,
    dimensions: 64,
    modelId,
    usage: {
      inputTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      totalTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
    },
  }
}

function fallbackRerank(input: RerankRequest, modelId: string): RerankResponse {
  const queryTerms = new Set(input.query.toLowerCase().split(/\s+/).filter(Boolean))
  const items = input.candidates
    .map((candidate) => ({
      id: candidate.id,
      score: lexicalScore(queryTerms, candidate.text),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.topK ?? input.candidates.length)

  return {
    items,
    modelId,
  }
}

function hashVector(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0)
  const digest = createHash("sha256").update(text).digest()

  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = ((digest[index % digest.length] / 255) * 2) - 1
  }

  return vector
}

function lexicalScore(queryTerms: Set<string>, text: string): number {
  const lowerText = text.toLowerCase()
  let score = 0
  for (const term of queryTerms) {
    if (lowerText.includes(term)) {
      score += 1
    }
  }
  return score / Math.max(1, queryTerms.size)
}
