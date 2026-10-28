import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildTool, contextFail, contextOk } from '@ema-agent/tools';
import type { CallVision } from '@ema-agent/vision';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { imageMediaTypeFor, readImageFile } from '../FileReadTool/imageReader.js';
import { DESCRIBE_IMAGE_DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  image_path: z.string().min(1).refine(value => path.isAbsolute(value), {
    message: 'image_path must be an absolute local file path.',
  }).describe('The absolute local path of the image whose content could not be provided to the main model.'),
}).strict();

interface DescribeImageToolContext {
  readonly vision: CallVision;
}

export const DescribeImageTool = buildTool<
  z.infer<typeof inputSchema>,
  string,
  DescribeImageToolContext
>({
  id: BuiltinTools.DescribeImage.id,
  name: BuiltinTools.DescribeImage.name,
  description: DESCRIBE_IMAGE_DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: input => `描述图片: ${path.basename(input.image_path)}`,

  validateContext(context) {
    if (!context.vision) return contextFail('DescribeImage requires a configured Vision model.');
    return contextOk({ vision: context.vision });
  },

  async checkPermissions(input) {
    return { kind: 'file', operation: 'read', path: input.image_path, target: 'file' };
  },

  async execute(input, context, invocation) {
    invocation.signal.throwIfAborted();
    const mediaType = imageMediaTypeFor(input.image_path);
    if (!mediaType) throw new Error('DescribeImage supports only PNG, JPEG, GIF, and WebP images.');
    const file = await stat(input.image_path);
    if (!file.isFile()) throw new Error('image_path must refer to a regular image file.');
    const image = await readImageFile({
      fullPath: input.image_path,
      displayPath: input.image_path,
      mediaType,
      sizeBytes: file.size,
      signal: invocation.signal,
    });
    // 文件读取权限由工具执行流程先处理. 每次显式调用都生成新描述, 不保存图片缓存.
    const result = await context.vision({
      images: [{ kind: 'base64', data: image.base64, mimeType: image.mediaType }],
      task: 'caption',
      signal: invocation.signal,
    });
    invocation.signal.throwIfAborted();
    return result.text;
  },
});
