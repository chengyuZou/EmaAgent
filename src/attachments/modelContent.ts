// 把持久化 Message 块里的 attachment_ref 穷尽投影成模型可见内容。
// Context/Compact/LLM 不查询 AttachmentStore——本函数是引用消失的唯一地点。

import { readFile } from 'node:fs/promises';
import type { UserBlock as LlmUserBlock } from '@ema-agent/llm';
import type { UserBlock as SessionUserBlock } from '@ema-agent/session';
import type { Attachment, ImageAttachment } from './types.js';

/** Vision 描述生产者由编排层注入；Attachments 不接触 Vision 连接。 */
export type DescribeAttachmentImage = (
  attachment: ImageAttachment,
  signal: AbortSignal,
) => Promise<string>;

export interface ResolveAttachmentOptions {
  /** 当前 Turn 冻结的模型事实：是否支持图片输入。 */
  readonly supportsImageInput: boolean;
  /** 模型不支持图片时的 Vision 描述入口；缺省时降级为说明文本。 */
  readonly describeImage?: DescribeAttachmentImage;
  readonly signal?: AbortSignal;
}

/**
 * 穷尽转换：每个 attachment_ref 都变成 text 或 image_data；找不到记录、文件读不到、
 * Vision 失败都生成模型可见的失败文本，绝不用 filter 静默丢块。
 */
export async function resolveAttachmentReferences(
  blocks: readonly SessionUserBlock[],
  attachments: ReadonlyMap<string, Attachment>,
  options: ResolveAttachmentOptions,
): Promise<LlmUserBlock[]> {
  const output: LlmUserBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'attachment_ref') {
      // text/媒体块与 tool_result 原样透传（结构上即 Llm 内容块）。
      output.push(block as LlmUserBlock);
      continue;
    }
    output.push(await resolveOne(
      block.attachmentId,
      attachments,
      options,
    ));
  }
  return output;
}

async function resolveOne(
  id: string,
  attachments: ReadonlyMap<string, Attachment>,
  options: ResolveAttachmentOptions,
): Promise<LlmUserBlock> {
  const attachment = attachments.get(id);
  if (!attachment) {
    return { type: 'text', text: '[附件记录已不存在]' };
  }

  if (attachment.kind === 'file') {
    return {
      type: 'text',
      text: `[附件：${attachment.name}，路径：${attachment.sourcePath}]`,
    };
  }

  if (options.supportsImageInput) {
    try {
      const bytes = await readFile(attachment.imagePath);
      return {
        type: 'image_data',
        data: bytes.toString('base64'),
        mimeType: attachment.mimeType,
        name: attachment.name,
      };
    } catch {
      return { type: 'text', text: `[附件图片无法读取：${attachment.name}]` };
    }
  }

  if (options.describeImage) {
    try {
      const description = await options.describeImage(attachment, options.signal ?? new AbortController().signal);
      return { type: 'text', text: `[图片附件 ${attachment.name} 的描述：${description}]` };
    } catch {
      // Vision 失败落到通用说明文本，不中断整条历史组装。
    }
  }
  return { type: 'text', text: `[图片附件：${attachment.name}（当前模型不支持图片输入）]` };
}
