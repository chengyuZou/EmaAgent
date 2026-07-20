// 定义各家 LLM 协议适配器必须实现的统一流式边界。
import type { LlmRequest, LlmStreamChunk } from '../types.js';

/**
 * 每个 provider adapter 必须满足的契约。
 * LanguageModelRuntime 根据 Provider 快照选择 adapter 后调用 stream()。
 *
 * @param request   完整请求(messages、tools、signal 等)
 * @param modelName 斜杠后的模型段,例如 "gpt-4o"
 */
export interface LlmAdapter {
  stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk>;
}
