import type { ContentPart, LlmTool, Message, ToolResultContentPart } from '@ema-agent/llm';

/**
 * 按 UTF-16 码元粗略估算: ASCII 每 4 个计 1 Token, 其余每 1.5 个计 1 Token.
 * 不区分具体语言或模型, 不保证固定误差范围, 不能用于计费.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) {
      ascii++;
    } else {
      nonAscii++;
    }
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

/**
 * 只估算传入的模型消息与工具定义. 完整输入需由调用方包含 system 消息,
 * 并先把附件引用转换为模型实际接收的内容; 本函数不读取文件或调用 Vision.
 */
export function estimateMessagesTokens(
  messages: readonly Message[],
  tools: readonly LlmTool[] = [],
): number {
  let total = 0;
  for (const message of messages) {
    // 每条消息预留 10 Token 表示角色等格式开销, 不代表某个协议的精确值.
    total += 10;
    if (typeof message.content === 'string') {
      total += estimateTextTokens(message.content);
      continue;
    }

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
        case 'gemini_thought':
          total += estimateTextTokens(block.text);
          break;
        case 'thinking':
          total += estimateTextTokens(block.thinking);
          break;
        case 'reasoning':
          total += estimateTextTokens(block.summaryText ?? '');
          break;
        case 'tool_use':
          total += 20 + estimateSerializedValue(block.args);
          break;
        case 'tool_result':
          if (typeof block.content === 'string') {
            total += estimateTextTokens(block.content);
          } else {
            for (const part of block.content) {
              total += estimateToolResultPart(part);
            }
          }
          break;
        default:
          total += estimateMediaPart(block);
      }
    }
  }

  for (const tool of tools) {
    total += estimateToolDefinition(tool);
  }
  return total;
}

// 缺少媒体尺寸, 时长或页数时使用固定估算, 不保证一定高于实际用量.
const IMAGE_FALLBACK_TOKENS = 5_334;
const AUDIO_UNKNOWN_FALLBACK_TOKENS = 8_000;
const AUDIO_TOKENS_PER_SECOND = 32;
const DOCUMENT_UNKNOWN_FALLBACK_TOKENS = 8_000;
const DOCUMENT_TOKENS_PER_PAGE = 2_000;

function estimateMediaPart(part: ContentPart): number {
  switch (part.type) {
    case 'image_data':
    case 'image_url':
      return estimateImageTokens(part.width, part.height);
    case 'audio_data':
      if (!isPositiveFinite(part.durationMs)) return AUDIO_UNKNOWN_FALLBACK_TOKENS;
      return Math.max(1, Math.ceil((part.durationMs / 1_000) * AUDIO_TOKENS_PER_SECOND));
    case 'file_data':
    case 'file_url':
      if (!isPositiveFinite(part.pageCount)) return DOCUMENT_UNKNOWN_FALLBACK_TOKENS;
      return Math.ceil(part.pageCount) * DOCUMENT_TOKENS_PER_PAGE;
    case 'text':
      return estimateTextTokens(part.text);
  }
}

function estimateToolResultPart(part: ToolResultContentPart): number {
  if (part.type === 'text') return estimateTextTokens(part.text);
  return estimateImageTokens(part.width, part.height);
}

function estimateImageTokens(width: number | undefined, height: number | undefined): number {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return IMAGE_FALLBACK_TOKENS;
  return Math.min(IMAGE_FALLBACK_TOKENS, Math.max(85, Math.ceil((width * height) / 750)));
}

function estimateToolDefinition(tool: LlmTool): number {
  try {
    return 20 + estimateTextTokens(JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  } catch {
    return 1_000;
  }
}

function estimateSerializedValue(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value) ?? 'null');
  } catch {
    return 1_000;
  }
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
