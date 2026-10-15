import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mimeForPath } from '@ema-agent/attachments';
import type { VisionDescriptionCache } from '@ema-agent/attachments';
import type { ContentPart, UserBlock } from '@ema-agent/llm';
import type { AttachmentBlock, ImageReferenceBlock } from '@ema-agent/session';

type ImagePart = Extract<ContentPart, { type: 'image_data' | 'image_url' }>;
export type DescribeImage = (image: ImagePart, signal: AbortSignal) => Promise<string>;

export interface BuildAttachmentMessagesOptions {
  readonly supportsImageInput: boolean;
  /** 仅附件按真实文件路径缓存描述. 工具图片不写入这个缓存. */
  readonly visionCache?: Pick<VisionDescriptionCache, 'getOrCreate'>;
  readonly describeImage?: DescribeImage;
  readonly signal: AbortSignal;
}

export async function buildAttachmentMessages(
  block: AttachmentBlock,
  options: BuildAttachmentMessagesOptions,
): Promise<UserBlock[]> {
  switch (block.type) {
    case 'file_reference':
      return [{
        type: 'text',
        text: `[附件: ${path.basename(block.path)}, 路径: ${block.path}]`,
      }];
    case 'pasted_text_reference':
      return [{
        type: 'text',
        text: `[粘贴文本: ${block.path}]\n内容预览:\n${block.preview}`,
      }];
    case 'image_reference':
      return buildImageMessages(block, options);
  }
}

async function buildImageMessages(
  block: ImageReferenceBlock,
  options: BuildAttachmentMessagesOptions,
): Promise<UserBlock[]> {
  const label = block.name
    ? `[图片: ${block.name}, 路径: ${block.path}]`
    : `[图片: ${block.path}]`;

  const readImage = async (): Promise<ImagePart> => {
    const bytes = await readFile(block.path, { signal: options.signal });
    return {
      type: 'image_data',
      data: bytes.toString('base64'),
      mimeType: mimeForPath(block.path),
      ...(block.name ? { name: block.name } : {}),
    };
  };
  const { describeImage, visionCache } = options;
  let describe: (() => Promise<string>) | undefined;
  if (describeImage) {
    const produce = async (): Promise<string> => describeImage(await readImage(), options.signal);
    describe = visionCache
      ? () => visionCache.getOrCreate(block.path, options.signal, produce)
      : produce;
  }

  try {
    options.signal.throwIfAborted();
    if (!options.supportsImageInput) {
      if (!describe) {
        return [{
          type: 'text',
          text: `${label}\n[系统提示: 当前模型不支持图片输入且未配置 Vision 模型, 未读取图片内容]`,
        }];
      }
      try {
        const description = await describe();
        options.signal.throwIfAborted();
        return [{
          type: 'text',
          text: `${label}\n[系统提示: 当前模型不支持图片输入, 以下是 Vision 模型生成的描述]\n${description}`,
        }];
      } catch (error) {
        options.signal.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return [{ type: 'text', text: `${label}\n[系统提示: 图片描述生成失败, 未读取图片内容]` }];
      }
    }
    return [{ type: 'text', text: label }, await readImage()];
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return [{
      type: 'text',
      text: `[系统提示: 这张图片的文件已不存在或无法读取, 路径: ${block.path}]`,
    }];
  }
}
