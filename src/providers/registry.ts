// 汇总 Ema 内置供应商定义，并提供按身份和能力查询的唯一目录入口。
import type { Capability, ProviderDefinition } from './types.js';
import { provider as anthropic } from './definitions/anthropic/index.js';
import { provider as dashscope } from './definitions/dashscope/index.js';
import { provider as deepseek } from './definitions/deepseek/index.js';
import { provider as fireworks } from './definitions/fireworks/index.js';
import { provider as gemini } from './definitions/gemini/index.js';
import { provider as gptSovits } from './definitions/gpt-sovits/index.js';
import { provider as groq } from './definitions/groq/index.js';
import { provider as jina } from './definitions/jina/index.js';
import { provider as lmstudio } from './definitions/lmstudio/index.js';
import { provider as mistral } from './definitions/mistral/index.js';
import { provider as moonshot } from './definitions/moonshot/index.js';
import { provider as ollama } from './definitions/ollama/index.js';
import { provider as openai } from './definitions/openai/index.js';
import { provider as openrouter } from './definitions/openrouter/index.js';
import { provider as perplexity } from './definitions/perplexity/index.js';
import { provider as siliconflow } from './definitions/siliconflow/index.js';
import { provider as together } from './definitions/together/index.js';
import { provider as xai } from './definitions/xai/index.js';
import { provider as zhipu } from './definitions/zhipu/index.js';
import { providerSupportsCapability } from './definition-utils.js';

// 顺序同时用于设置页展示；新增供应商时应显式选择位置，不能依赖文件系统遍历顺序。
const ALL_DEFINITIONS: readonly ProviderDefinition[] = [
  openai,
  anthropic,
  gemini,
  deepseek,
  moonshot,
  zhipu,
  openrouter,
  groq,
  mistral,
  xai,
  perplexity,
  together,
  fireworks,
  ollama,
  lmstudio,
  siliconflow,
  jina,
  dashscope,
  gptSovits,
];

export const PROVIDER_DEFINITIONS: Readonly<Record<string, ProviderDefinition>> =
  Object.freeze(Object.fromEntries(ALL_DEFINITIONS.map((definition) => [definition.id, definition])));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS[id];
}

export function listProviderDefinitions(): readonly ProviderDefinition[] {
  return ALL_DEFINITIONS;
}

export function providersWithCapability(capability: Capability): readonly ProviderDefinition[] {
  return ALL_DEFINITIONS.filter((definition) => providerSupportsCapability(definition, capability));
}

export function listProviderDefinitionIds(): readonly string[] {
  return ALL_DEFINITIONS.map((definition) => definition.id);
}

/** 目录 get/list 的纯函数绑定，供控制面注入与现有调用点使用。 */
export const providerCatalog = {
  get: getProviderDefinition,
  list: listProviderDefinitions,
};
