import type { LlmRequest, LlmStreamChunk } from '../types.js';

/**
 * Contract every provider adapter must satisfy.
 * The router calls stream() after routing the model string to the right adapter.
 *
 * @param request   Full request (messages, tools, signal, …)
 * @param modelName The model segment after the slash, e.g. "gpt-4o"
 */
export interface LlmAdapter {
  stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk>;
}
