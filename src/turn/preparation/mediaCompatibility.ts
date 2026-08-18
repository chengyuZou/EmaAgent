// 原始 ContentPart 图片输入的模型能力适配：支持则透传，不支持则 Vision 描述降级。
import type { ContentPart } from '@ema-agent/llm';
import type { RequestDegradationNotice } from '@ema-agent/turn-terms';

type ImageDataPart = Extract<ContentPart, { type: 'image_data' }>;

export interface ImageDowngradeInput {
  /** 逐张图片生成文本描述；抛错即中断准备（不让原图试探性发给不支持图片的模型）。 */
  readonly describeImage: (image: ImageDataPart) => Promise<string>;
}

export interface PreparedContentImages {
  readonly parts: readonly ContentPart[];
  readonly degradation?: RequestDegradationNotice;
}

/**
 * 模型支持图片输入（含 attachment ref 已解析出的 image_data）时原样透传；
 * 不支持时必须把原始图片成功转换为文本描述。image_url 不主动抓取，
 * 无法安全转换时直接抛错——由调用方映射为准备失败。
 */
export async function prepareImagesForModel(
  parts: readonly ContentPart[],
  supportsImageInput: boolean,
  downgrade: ImageDowngradeInput,
): Promise<PreparedContentImages> {
  const imageCount = parts.filter(
    (part) => part.type === 'image_data' || part.type === 'image_url',
  ).length;
  if (imageCount === 0 || supportsImageInput) return { parts };

  const images = parts.filter(
    (part): part is ImageDataPart => part.type === 'image_data',
  );
  if (images.length !== imageCount) {
    throw new Error('URL 图片无法安全转换为描述');
  }

  const descriptions = await Promise.all(
    images.map((image) => downgrade.describeImage(image)),
  );
  const text = descriptions
    .map((description, index) => images.length > 1
      ? `### 图片 ${index + 1}\n${description}`
      : description)
    .join('\n\n');

  return {
    parts: replaceImageParts(parts, [{
      type: 'text',
      text: `[图片内容（由 Vision 模型生成的描述）]\n${text}`,
    }]),
    degradation: {
      attempt: 1,
      reason: '当前 LLM 不支持图片输入，已通过 Vision 模型转换为描述',
      removed: ['image'],
      replacements: ['description'],
    },
  };
}

/** 用单个描述块替换请求中的全部图片，同时保持其他内容块的原始顺序。 */
export function replaceImageParts(
  original: readonly ContentPart[],
  replacement: readonly ContentPart[],
): ContentPart[] {
  const output: ContentPart[] = [];
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
