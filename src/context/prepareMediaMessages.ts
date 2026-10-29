import type { ContentPart, Message, ToolResultContentPart, UserBlock } from '@ema-agent/llm';
import { LLMRequestTooLargeError } from '@ema-agent/llm';
import type { MediaSettings } from './mediaSettings.js';

type ImagePart = Extract<ContentPart, { type: 'image_data' }>;
type MediaPart = Exclude<ContentPart, { type: 'text' }>;

// 同一个图片块会被后续请求反复使用. 缓存编码结果避免重复压缩, 原消息不再使用时可一起回收.
const encodedImages = new WeakMap<ImagePart, Promise<ImagePart>>();

async function encodeImage(part: ImagePart): Promise<ImagePart> {
  if (part.mimeType !== 'image/png') return part;
  let pending = encodedImages.get(part);
  if (!pending) {
    pending = (async () => {
      // 只有确实发送 PNG 时才加载图片库, 普通文本请求不加载原生模块.
      const { default: sharp } = await import('sharp');
      const image = sharp(Buffer.from(part.data, 'base64'));
      const metadata = await image.metadata();
      // 透明图保留透明通道, 其他 PNG 使用 JPEG 80. 所有来源的图片遵守同一规则.
      const encoder = metadata.hasAlpha ? image.png({ compressionLevel: 9 }) : image.jpeg({ quality: 80 });
      const { data, info } = await encoder.toBuffer({ resolveWithObject: true });
      const encoded = data.toString('base64');
      if (encoded.length >= part.data.length) return part;
      // 不缩放或裁切, 模型看到的像素坐标仍与 Rust 观察一致.
      return {
        ...part,
        data: encoded,
        mimeType: metadata.hasAlpha ? 'image/png' : 'image/jpeg',
        width: info.width,
        height: info.height,
      };
    })();
    encodedImages.set(part, pending);
    void pending.catch(() => encodedImages.delete(part));
  }
  return pending;
}

/** 每次模型请求前处理副本, 保留消息顺序和 ToolCall 配对, 不修改 SQL 或本地原图. */
export async function prepareMediaMessages(
  messages: readonly Message[],
  settings: MediaSettings,
  signal: AbortSignal,
): Promise<readonly Message[]> {
  signal.throwIfAborted();
  const media: MediaPart[] = [];
  const collect = (part: ContentPart): void => {
    if (part.type !== 'text') media.push(part);
  };
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') continue;
        for (const part of block.content) collect(part);
      } else {
        collect(block);
      }
    }
  }
  if (media.length === 0) return messages;

  const replacements: ContentPart[] = new Array(media.length);
  let keptCount = 0;
  let keptBytes = 0;
  // 从新到旧保留完整媒体项. 超限后省略旧项, 不截断 base64, 不生成不存在的画面描述.
  let budgetFull = false;
  for (let index = media.length - 1; index >= 0; index -= 1) {
    signal.throwIfAborted();
    const item = media[index]!;
    if (budgetFull || keptCount >= settings.maxItems) {
      replacements[index] = omittedMedia();
      continue;
    }
    const part = item.type === 'image_data' ? await encodeImage(item) : item;
    signal.throwIfAborted();
    // URL 只计算请求中地址的字节, 不下载远端媒体猜测其大小. 内联内容按实际编码字节计算.
    const bytes = Buffer.byteLength('data' in part ? part.data : part.url, 'utf8');
    if (keptBytes + bytes > settings.maxBytes) {
      if (keptCount === 0) {
        throw new LLMRequestTooLargeError('最新媒体项超过本地发送体积预算, 请减小附件或调整媒体参数.');
      }
      budgetFull = true;
      replacements[index] = omittedMedia();
      continue;
    }
    replacements[index] = part;
    keptCount += 1;
    keptBytes += bytes;
  }

  // 没有压缩或省略时复用原消息数组, 避免每轮为相同历史重建对象.
  if (replacements.every((part, index) => part === media[index])) return messages;

  let index = 0;
  const replace = (part: ContentPart): ContentPart => part.type === 'text' ? part : replacements[index++]!;
  return messages.map(message => {
    if (message.role !== 'user' || typeof message.content === 'string') return message;
    const content: UserBlock[] = message.content.map(block => {
      if (block.type !== 'tool_result') return replace(block);
      if (typeof block.content === 'string') return block;
      return { ...block, content: block.content.map(part => replace(part) as ToolResultContentPart) };
    });
    return { ...message, content };
  });
}

function omittedMedia(): Extract<ContentPart, { type: 'text' }> {
  return {
    type: 'text',
    text: '[较早的媒体因本次请求数量或体积预算被省略, 原内容仍保留在本地历史或附件中; 有附件路径时可重新读取.]',
  };
}
