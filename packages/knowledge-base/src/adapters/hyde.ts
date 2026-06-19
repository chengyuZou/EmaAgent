/**
 * HyDE — Hypothetical Document Embedding.
 *
 * Instead of embedding the user's query directly, an LLM generates a short
 * "hypothetical answer passage" that resembles the kind of text the document
 * would contain. Embedding that passage bridges the semantic gap between
 * conversational queries and formal document language.
 *
 * The caller (e.g. apps/core) wires up a concrete implementation that calls
 * the LLM router with an appropriate prompt.
 */
export interface KbHydeAdapter {
  /** Generate a hypothetical document passage for the given query.
   *  Should return 1-3 sentences in the expected document language.
   *  Throws or rejects on failure — the caller will fall back to the raw query. */
  generateHypoDoc(query: string, signal?: AbortSignal): Promise<string>;
}
