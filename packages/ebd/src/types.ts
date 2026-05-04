export interface EmbedRequest {
  input: string | string[]
  modelId?: string
}

export interface EmbedResponse {
  embeddings: number[][]
  dimensions: number
  modelId: string
  usage?: {
    inputTokens: number
    totalTokens: number
  }
}

export interface RerankRequest {
  query: string
  candidates: Array<{
    id: string
    text: string
  }>
  modelId?: string
  topK?: number
}

export interface RerankResponse {
  items: Array<{
    id: string
    score: number
  }>
  modelId: string
}

export interface EbdBridgeHealth {
  ok: boolean
  status: "ok" | "down" | "fallback"
  message?: string
}
