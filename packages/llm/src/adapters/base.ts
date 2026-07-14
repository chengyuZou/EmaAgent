import type { LlmRequest, LlmStreamChunk } from '../types.js';

/**
 * 每个 provider adapter 必须满足的契约。
 * router 把模型字符串路由到对应 adapter 后调 stream()。
 *
 * @param request   完整请求(messages、tools、signal 等)
 * @param modelName 斜杠后的模型段,例如 "gpt-4o"
 */
export interface LlmAdapter {
  stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk>;
}
