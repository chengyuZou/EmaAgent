// 为根 Turn 的图片输入选择原图透传或 Vision 描述降级，能力未知时保持失败关闭。

import type { RequestDegradationNotice } from '@ema-agent/turn';
import type { SessionId, TurnId } from '@ema-agent/ids';
import {
  LlmModelCapabilityError,
  type LlmContentPart,
} from '@ema-agent/llm';
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';
import type { AttachmentImageNormalizationOptions } from '@ema-agent/attachment';

export interface VisionModelBinding {
  readonly providerConfigId: string;
  readonly model: string;
}

export interface TurnImageDescriptionInput {
  readonly data: string;
  readonly mimeType: string;
  readonly name?: string;
}

export interface MediaCompatibilityServices {
  visionBinding(): VisionModelBinding | undefined;
  describeImage(input: {
    readonly providerId: string;
    readonly model: string;
    readonly image: TurnImageDescriptionInput;
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly normalization: Readonly<AttachmentImageNormalizationOptions>;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface PreparedImageInput {
  readonly parts: readonly LlmContentPart[];
  readonly degradation?: RequestDegradationNotice;
}

/**
 * 当前模型明确支持图片时原样透传；不支持或能力未知时必须成功转换为
 * Vision 描述。转换不可用时明确拒绝，不能把原图试探性发送给模型。
 */
export async function prepareImagesForModel(
  services: MediaCompatibilityServices,
  model: {
    readonly providerId: string;
    readonly model: string;
    readonly capabilities: ModelCapabilitySnapshot;
  },
  imageParts: readonly LlmContentPart[],
  identity: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
  },
  normalization: Readonly<AttachmentImageNormalizationOptions>,
  signal: AbortSignal,
): Promise<PreparedImageInput> {
  if (model.capabilities.input.image === 'supported') {
    return { parts: imageParts.map((part) => ({ ...part })) };
  }

  const binding = services.visionBinding();
  if (!binding) {
    throw imageCapabilityError(
      model,
      '没有可用的 Vision 模型生成图片描述',
    );
  }

  const images: TurnImageDescriptionInput[] = imageParts
    .filter((part): part is Extract<LlmContentPart, { type: 'image_data' }> =>
      part.type === 'image_data')
    .map((part) => ({
      data: part.data,
      mimeType: part.mimeType,
      name: part.name,
    }));

  if (images.length !== imageParts.length) {
    throw imageCapabilityError(model, 'URL 图片无法安全转换为描述');
  }

  try {
    const descriptions = await Promise.all(images.map((image) =>
      services.describeImage({
        providerId: binding.providerConfigId,
        model: binding.model,
        image,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        normalization,
        signal,
      })));
    const description = descriptions
      .map((text, index) => images.length > 1
        ? `### 图片 ${index + 1}\n${text}`
        : text)
      .join('\n\n');

    return {
      parts: [{
        type: 'text',
        text: `[图片内容（由 Vision 模型生成的描述）]\n${description}`,
      }],
      degradation: {
        attempt: 1,
        reason: model.capabilities.input.image === 'unknown'
          ? '当前 LLM 的图片能力未知，已通过 Vision 模型转换为描述'
          : '当前 LLM 不支持图片，已通过 Vision 模型转换为描述',
        removed: ['image'],
        replacements: ['description'],
      },
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof LlmModelCapabilityError) throw error;
    throw imageCapabilityError(model, 'Vision 图片描述失败');
  }
}

/** 用单个描述块替换请求中的全部图片，同时保持其他内容块的原始顺序。 */
export function replaceImageParts(
  original: readonly LlmContentPart[],
  replacement: readonly LlmContentPart[],
): LlmContentPart[] {
  const output: LlmContentPart[] = [];
  let inserted = false;
  for (const part of original) {
    if (part.type === 'image_data' || part.type === 'image_url') {
      if (!inserted) {
        output.push(...replacement);
        inserted = true;
      }
      continue;
    }
    output.push(part);
  }
  return output;
}

function imageCapabilityError(
  model: {
    readonly providerId: string;
    readonly model: string;
    readonly capabilities: ModelCapabilitySnapshot;
  },
  detail: string,
): LlmModelCapabilityError {
  const state = model.capabilities.input.image;
  return new LlmModelCapabilityError(model.providerId, model.model, [{
    kind: 'input',
    messageIndex: 0,
    partIndex: 0,
    modality: 'image',
    state: state === 'supported' ? 'unknown' : state,
    reason: detail,
  }]);
}
