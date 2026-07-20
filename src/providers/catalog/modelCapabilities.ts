// 统一表达模型的输入模态、工具、推理、窗口能力及其可信来源。
import type { ModelsDevCatalog, ModelsDevSpec } from './modelsDevCatalog.js';

export type ModelCapabilityState = 'supported' | 'unsupported' | 'unknown';
export type ModelCapabilitySource = 'catalog' | 'live' | 'manual' | 'unknown';

/** 当前 Provider + Model 的只读能力事实。 */
export interface ModelCapabilitySnapshot {
  input: {
    text: ModelCapabilityState;
    image: ModelCapabilityState;
    audio: ModelCapabilityState;
    file: ModelCapabilityState;
  };
  tools: ModelCapabilityState;
  reasoning: ModelCapabilityState;
  temperature: ModelCapabilityState;
  contextWindow?: number;
  maxOutput?: number;
  source: ModelCapabilitySource;
}

/** 运行时 Provider 配置已经解析出的模型身份，不包含凭据。 */
export interface ModelCapabilityQuery {
  providerId: string;
  model: string;
  modelsDevId?: string;
}

/** Provider 模块向 Context、LLM 和设置页提供的统一能力查询边界。 */
export interface ModelCapabilityResolver {
  resolve(query: ModelCapabilityQuery): ModelCapabilitySnapshot;
}

export function createModelCapabilityResolver(
  catalog: ModelsDevCatalog,
  options: {
    supportsManualImageInput?: (providerId: string, model: string) => boolean;
  } = {},
): ModelCapabilityResolver {
  return {
    resolve(query) {
      const spec = query.modelsDevId
        ? catalog.get(query.modelsDevId, query.model)
        : undefined;
      if (spec) return capabilitiesFromCatalog(spec);
      if (options.supportsManualImageInput?.(query.providerId, query.model)) {
        return capabilitiesFromManualVision();
      }
      return unknownModelCapabilities();
    },
  };
}

export function unknownModelCapabilities(): ModelCapabilitySnapshot {
  return {
    input: {
      // 能进入 LLM 模型池至少说明它接受文本；其他模态禁止靠协议猜测。
      text: 'supported',
      image: 'unknown',
      audio: 'unknown',
      file: 'unknown',
    },
    tools: 'unknown',
    reasoning: 'unknown',
    temperature: 'unknown',
    source: 'unknown',
  };
}

export function capabilitiesFromCatalog(spec: ModelsDevSpec): ModelCapabilitySnapshot {
  return {
    input: {
      text: modalityState(spec.inputModalities, 'text', true),
      image: modalityState(spec.inputModalities, 'image'),
      audio: modalityState(spec.inputModalities, 'audio'),
      file: modalityState(spec.inputModalities, 'file'),
    },
    tools: spec.toolCall ? 'supported' : 'unsupported',
    reasoning: spec.reasoning ? 'supported' : 'unsupported',
    temperature: spec.temperature ? 'supported' : 'unsupported',
    contextWindow: spec.contextWindow,
    maxOutput: spec.maxOutput,
    source: 'catalog',
  };
}

/** Catalog 未收录时，设置页启用的 Vision 模型可作为显式人工声明。 */
export function capabilitiesFromManualVision(): ModelCapabilitySnapshot {
  const snapshot = unknownModelCapabilities();
  return {
    ...snapshot,
    input: { ...snapshot.input, image: 'supported' },
    source: 'manual',
  };
}

function modalityState(
  declared: readonly string[],
  modality: string,
  textDefault = false,
): ModelCapabilityState {
  if (declared.length === 0) return textDefault ? 'supported' : 'unknown';
  return declared.includes(modality) ? 'supported' : 'unsupported';
}
