// 定义业务模块调用语言模型时可见的稳定边界，隐藏 Provider 热重载和 Adapter 管理。
import type {
  LlmCompletion,
  LlmRequest,
  LlmStreamChunk,
} from './types.js';

export interface LanguageModel {
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}
