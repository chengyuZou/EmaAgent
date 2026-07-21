// 定义业务模块调用语言模型时可见的稳定边界，隐藏 Provider 热重载和 Adapter 管理。
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';
import type { UnsupportedPart } from './validate.js';
import type {
  LlmCompletion,
  LlmContentPart,
  LlmRequest,
  LlmStreamChunk,
} from './types.js';

export interface LanguageModel {
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
  complete(request: LlmRequest): Promise<LlmCompletion>;

  /** 过渡期能力查询；Context 完成独立装配后从模型调用接口移除。 */
  capabilitiesFor(providerId: string, model: string): ModelCapabilitySnapshot;
  warnUnsupportedParts(providerId: string, parts: LlmContentPart[]): UnsupportedPart[];
}
