// 定义业务模块调用语言模型时可见的稳定边界，隐藏 Provider 热重载和 Adapter 管理。
import type { CompatibleMessageView } from './messageCompatibility.js';
import type { UnsupportedPart } from './validate.js';
import type {
  LlmCompletion,
  LlmContentPart,
  Message,
  LlmRequest,
  LlmStreamChunk,
} from './types.js';

export interface LanguageModel {
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
  complete(request: LlmRequest): Promise<LlmCompletion>;

  /** 过渡期兼容接口；模型绑定接线完成后由调用方显式传入 Provider 与 Model。 */
  firstProviderId(): string | undefined;
  /** 过渡期兼容接口；模型绑定接线完成后由调用方显式传入 Provider 与 Model。 */
  defaultModelFor(providerId: string): string | undefined;

  prepareHistoricalMessages(
    providerId: string,
    model: string,
    messages: readonly Message[],
  ): CompatibleMessageView;
  assertCurrentContentCompatible(
    providerId: string,
    model: string,
    parts: readonly LlmContentPart[],
  ): void;
  warnUnsupportedParts(providerId: string, parts: LlmContentPart[]): UnsupportedPart[];
}
