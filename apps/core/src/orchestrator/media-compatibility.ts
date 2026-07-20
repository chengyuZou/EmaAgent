import type { RequestDegradationNotice } from '@ema-agent/contracts';
import {
  LlmModelCapabilityError,
  type LlmContentPart,
  type ModelCapabilitySnapshot,
} from '@ema-agent/llm';
import type { VisionImageInput, VisionImageMime } from '@ema-agent/vision';

export interface VisionModelBinding {
  providerConfigId: string;
  model: string;
}

export interface MediaCompatibilityServices {
  capabilitiesFor(providerId: string, model: string): ModelCapabilitySnapshot;
  visionBinding(): VisionModelBinding | undefined;
  describeImages(input: {
    providerId: string;
    model: string;
    inputs: VisionImageInput[];
    signal: AbortSignal;
  }): Promise<string>;
}

export interface PreparedImageInput {
  parts: LlmContentPart[];
  degradation?: RequestDegradationNotice;
}

/**
 * 为本轮图片建立明确的模型兼容路径。
 *
 * 当前 LLM 明确支持图片时原样透传；unsupported/unknown 时必须成功转换为
 * Vision 文字描述。无法转换时 fail-closed，绝不把原图试探性发送给当前 LLM。
 */
export async function prepareImagesForModel(
  services: MediaCompatibilityServices,
  providerId: string,
  model: string,
  imageParts: readonly LlmContentPart[],
  signal: AbortSignal,
): Promise<PreparedImageInput> {
  const capabilities = services.capabilitiesFor(providerId, model);
  if (capabilities.input.image === 'supported') {
    return { parts: imageParts.map((part) => ({ ...part })) };
  }

  const binding = services.visionBinding();
  if (!binding) {
    throw imageCapabilityError(providerId, model, capabilities.input.image, '没有可用的 Vision 模型生成图片描述');
  }

  const base64Inputs: VisionImageInput[] = imageParts
    .filter((part): part is Extract<LlmContentPart, { type: 'image_data' }> => part.type === 'image_data')
    .map((part) => ({
      kind: 'base64',
      data: part.data,
      mimeType: part.mimeType as VisionImageMime,
    }));

  if (base64Inputs.length !== imageParts.length) {
    throw imageCapabilityError(providerId, model, capabilities.input.image, 'URL 图片无法安全转换为描述');
  }

  try {
    const description = await services.describeImages({
      providerId: binding.providerConfigId,
      model: binding.model,
      inputs: base64Inputs,
      signal,
    });
    return {
      parts: [{ type: 'text', text: `[图片内容（由 Vision 模型生成的描述）]\n${description}` }],
      degradation: {
        attempt: 1,
        reason: capabilities.input.image === 'unknown'
          ? '当前 LLM 的图片能力未知，已通过 Vision 模型转换为描述'
          : '当前 LLM 不支持图片，已通过 Vision 模型转换为描述',
        removed: ['image'],
        replacements: ['description'],
      },
    };
  } catch (error) {
    // 用户取消必须保留原始取消原因，不能伪装成模型能力错误。
    if (signal.aborted) throw error;
    if (error instanceof LlmModelCapabilityError) throw error;
    throw imageCapabilityError(providerId, model, capabilities.input.image, 'Vision 图片描述失败');
  }
}

/** 用单个描述块替换同一请求中的全部图片，保持其他内容块的原始顺序。 */
export function replaceImageParts(
  original: readonly LlmContentPart[],
  replacement: readonly LlmContentPart[],
): LlmContentPart[] {
  const out: LlmContentPart[] = [];
  let inserted = false;
  for (const part of original) {
    if (part.type === 'image_data' || part.type === 'image_url') {
      if (!inserted) {
        out.push(...replacement);
        inserted = true;
      }
      continue;
    }
    out.push(part);
  }
  return out;
}

function imageCapabilityError(
  providerId: string,
  model: string,
  state: 'supported' | 'unsupported' | 'unknown',
  detail: string,
): LlmModelCapabilityError {
  return new LlmModelCapabilityError(providerId, model, [{
    kind: 'input',
    messageIndex: 0,
    partIndex: 0,
    modality: 'image',
    state: state === 'supported' ? 'unknown' : state,
    reason: detail,
  }]);
}
