// 附件块 → 模型内容块:持久化只有 path(与 preview/name),这里决定模型真正看到什么。
// 组装期零预检:唯一的 IO 是图片读字节(工作内容),失败投影为系统提示文本,
// 任何情况不炸 Turn。同一块的投影输出跨轮字节稳定(前缀缓存对字节级一致敏感)。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mimeForPath } from '@ema-agent/attachments';
import type { VisionDescriptionCache, VisionDescriptionProducer } from '@ema-agent/attachments';
import type { UserBlock } from '@ema-agent/llm';
import type { AttachmentBlock, ImageReferenceBlock } from '@ema-agent/session';

export interface BuildAttachmentMessagesOptions {
  readonly supportsImageInput: boolean;
  /** 主模型不支持图片时的描述缓存;与 describeImage 同时注入才会现做生产。 */
  readonly visionCache?: Pick<VisionDescriptionCache, 'getOrCreate'>;
  /** Vision 生产者:拿图片 path 读字节调 Vision 模型,由 Turn 层接线注入。 */
  readonly describeImage?: VisionDescriptionProducer;
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

  if (options.supportsImageInput) {
    try {
      const bytes = await readFile(block.path);
      return [
        { type: 'text', text: label },
        {
          type: 'image_data',
          data: bytes.toString('base64'),
          mimeType: mimeForPath(block.path),
          ...(block.name ? { name: block.name } : {}),
        },
      ];
    } catch (error) {
      rethrowAbort(error, options.signal);
      return [{
        type: 'text',
        text: `[系统提示: 这张图片的文件已不存在或无法读取, 路径: ${block.path}]`,
      }];
    }
  }

  if (options.visionCache && options.describeImage) {
    try {
      const description = await options.visionCache.getOrCreate(
        block.path,
        options.signal,
        options.describeImage,
      );
      return [{
        type: 'text',
        text: `${label}\n[系统提示: 当前模型不支持图片输入, 以下是 Vision 模型生成的描述]\n${description}`,
      }];
    } catch (error) {
      rethrowAbort(error, options.signal);
      return [{
        type: 'text',
        text: `[系统提示: 图片描述生成失败, 图片路径: ${block.path}]`,
      }];
    }
  }

  return [{
    type: 'text',
    text: `[系统提示: 用户附了一张图片, 当前模型不支持图片输入且未配置 Vision 模型, 路径: ${block.path}]`,
  }];
}

/** Turn 取消原样向上抛, 不伪装成降级。 */
function rethrowAbort(error: unknown, signal: AbortSignal): void {
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    throw error;
  }
}
