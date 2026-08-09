// 在中立消息跨入具体协议前拒绝无法无损表达的内容。
import type { LlmProtocol } from '@ema-agent/provider';
import { LlmProtocolInputError } from './errors.js';
import type {
  ContentPart,
  Message,
  ToolResultContentPart,
  UserBlock,
} from './message.js';

const ANTHROPIC_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function assertProtocolInput(
  protocol: LlmProtocol,
  messages: readonly Message[],
): void {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== 'user' || typeof message.content === 'string') continue;

    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex]!;
      if (block.type === 'tool_result') {
        assertToolResult(protocol, block.content, messageIndex, blockIndex);
      } else {
        assertContentPart(protocol, block, messageIndex, blockIndex);
      }
    }
  }
}

function assertContentPart(
  protocol: LlmProtocol,
  part: ContentPart,
  messageIndex: number,
  blockIndex: number,
): void {
  if (protocol === 'openai-llm') {
    if (part.type === 'file_data' || part.type === 'file_url') {
      fail(protocol, messageIndex, blockIndex, part.type, 'Chat Completions 没有文件内容块');
    }
    if (part.type === 'audio_data' && !isOpenAiAudio(part.mimeType)) {
      fail(protocol, messageIndex, blockIndex, part.type, `不支持音频类型 ${part.mimeType}`);
    }
    return;
  }

  if (protocol === 'openai-responses-llm') {
    if (part.type === 'audio_data') {
      fail(protocol, messageIndex, blockIndex, part.type, 'Responses 普通输入不接受音频内容块');
    }
    return;
  }

  if (protocol === 'anthropic-llm') {
    if (part.type === 'audio_data') {
      fail(protocol, messageIndex, blockIndex, part.type, 'Anthropic Messages 不接受音频内容块');
    }
    if (part.type === 'image_data' && !ANTHROPIC_IMAGE_TYPES.has(part.mimeType)) {
      fail(protocol, messageIndex, blockIndex, part.type, `不支持图片类型 ${part.mimeType}`);
    }
  }
}

function assertToolResult(
  protocol: LlmProtocol,
  content: string | readonly ToolResultContentPart[],
  messageIndex: number,
  blockIndex: number,
): void {
  if (typeof content === 'string') return;

  for (const part of content) {
    if (
      (protocol === 'openai-llm' || protocol === 'openai-responses-llm')
      && part.type !== 'text'
    ) {
      fail(protocol, messageIndex, blockIndex, part.type, '函数结果只接受文本内容');
    }
    if (protocol === 'anthropic-llm' && part.type === 'image_data'
      && !ANTHROPIC_IMAGE_TYPES.has(part.mimeType)) {
      fail(protocol, messageIndex, blockIndex, part.type, `不支持图片类型 ${part.mimeType}`);
    }
  }
}

function isOpenAiAudio(mimeType: string): boolean {
  return mimeType === 'audio/wav'
    || mimeType === 'audio/mp3'
    || mimeType === 'audio/mpeg';
}

function fail(
  protocol: LlmProtocol,
  messageIndex: number,
  blockIndex: number,
  contentType: UserBlock['type'],
  detail: string,
): never {
  throw new LlmProtocolInputError(
    protocol,
    messageIndex,
    blockIndex,
    contentType,
    detail,
  );
}
