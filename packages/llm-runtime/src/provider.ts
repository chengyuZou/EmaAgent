/**
 * Provider contracts for text generation, embedding, and reranking.
 */

import type { ChatCompletionChunk, ChatCompletionRequest, ModelDescriptor } from "@ema-agent/core-types";

/** OpenAI-compatible or native LLM provider. */
export interface LlmProvider {
  /** Stable provider ID, for example `openai` or `deepseek`. */
  readonly id: string;
  /** User-facing provider name. */
  readonly displayName: string;
  /** Provider website, used by settings UI. */
  readonly website?: string;
  /** Icon key or URL, used by settings UI. */
  readonly icon?: string;
  /** Models owned by this provider. */
  readonly models: readonly ModelDescriptor[];

  /**
   * Streams one chat completion request.
   *
   * Implementations must normalize provider-specific chunks into
   * `ChatCompletionChunk`; raw vendor chunks must not leak upward.
   */
  chatStream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk>;

  /** Runs one non-streaming chat completion request. */
  chat(request: ChatCompletionRequest): Promise<string>;
}

/** Embedding provider contract. */
export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Reranker provider contract. */
export interface Reranker {
  readonly id: string;
  rerank(query: string, texts: readonly string[]): Promise<Array<{ index: number; score: number }>>;
}
