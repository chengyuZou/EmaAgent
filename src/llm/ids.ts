// 定义一次逻辑语言模型调用的稳定身份，供重试、Usage 与 Hook 关联同一调用。

export type LlmCallId = string & { readonly __brand: 'LlmCallId' };

export function asLlmCallId(value: string): LlmCallId {
  return value as LlmCallId;
}
