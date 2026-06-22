/**
 * auto_questions — index-time question generation (RAGFlow-style).
 *
 * For each chunk, an LLM generates a few questions the chunk answers. Those
 * questions are embedded alongside (or instead of) the chunk body so that a
 * conversational user query matches "question ↔ question" instead of
 * "question ↔ statement", closing the phrasing gap at INDEX time (zero per-query
 * cost), complementing the query-time HyDE adapter.
 *
 * STATUS: interface only — intentionally left UNWIRED. The actual generation +
 * how generated questions feed embedding (separate vectors vs. appended to
 * searchText) is a frontend/product decision deferred per the V1 plan. A concrete
 * implementation (calling the LLM router with a prompt + cache) is injected later.
 *
 * See HyDE counterpart in ./hyde.ts.
 */
export interface KbAutoQuestionAdapter {
  /**
   * Generate up to `count` questions the given chunk text answers.
   * Should return [] (not throw) when generation is unavailable so ingest can
   * proceed without auto-questions. Implementations are expected to cache by
   * content hash to avoid re-generating on re-ingest.
   */
  generateQuestions(chunkText: string, count: number, signal?: AbortSignal): Promise<string[]>;
}
