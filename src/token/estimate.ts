// 估算消息、媒体和工具定义占用的上下文 Token，为压缩与预算决策提供统一依据。
import type {
  ContentPart,
  Message as ModelMessage,
  ToolResultContentPart,
} from '@ema-agent/llm';
import type {
  TokenEstimate,
  TokenEstimateBreakdown,
  TokenEstimateOptions,
  TokenEstimateWarningCode,
  TokenToolDefinition,
} from './types.js';

// ── Heuristic token estimate ─────────────────────────────────────────────────

/**
 * Cheap, no-API-call token estimation for compaction trigger checks.
 *
 * Heuristic (Anthropic/OpenAI tokenizers behave similarly enough for our use):
 *   English / code  : ~3.8 chars/token  → use 4
 *   Chinese (CJK)   : ~1.5 chars/token  → CJK weight 2.4
 *
 * We split the string roughly into ASCII + non-ASCII and apply different
 * divisors. Off by ±15% in the worst case — acceptable for "should we compact
 * now?" decisions but not for billing.
 *
 * Replace with Anthropic's `count_tokens` API when accuracy actually matters
 * (e.g. token-bar UI showing exact usage).
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk   = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Treat ASCII printable + space as 4-chars-per-token; rest as 1.5-chars
    if (code < 128) ascii++;
    else            cjk++;
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);
}

/**
 * Estimate the input token cost of a full ModelMessage[] array. Each message
 * gets a small per-message overhead (matches what Anthropic / OpenAI add for
 * role markers and message envelopes).
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return estimateLlmInputTokens(messages).totalTokens;
}

/**
 * 对完整 LLM 输入做快速保守估算。返回值只用于上下文预算和界面近似显示，
 * Provider 返回的 usage 才能作为真实消耗与计费事实。
 */
export function estimateLlmInputTokens(
  messages: readonly ModelMessage[],
  options: TokenEstimateOptions = {},
): TokenEstimate {
  const breakdown = emptyBreakdown();
  const warnings = new Set<TokenEstimateWarningCode>();

  for (const msg of messages) {
    breakdown.messageEnvelopeTokens += 10;

    if (typeof msg.content === 'string') {
      breakdown.textTokens += estimateTextTokens(msg.content);
      continue;
    }

    for (const block of msg.content) {
      if (block.type === 'text') {
        breakdown.textTokens += estimateTextTokens(block.text);
      } else if (block.type === 'thinking') {
        breakdown.textTokens += estimateTextTokens(block.thinking);
      } else if (block.type === 'reasoning') {
        breakdown.textTokens += estimateTextTokens(block.summaryText ?? '');
      } else if (block.type === 'gemini_thought') {
        breakdown.textTokens += estimateTextTokens(block.text);
      } else if (block.type === 'tool_use') {
        breakdown.otherTokens += 20 + estimateSerializedValue(block.args);
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          breakdown.textTokens += estimateTextTokens(block.content);
        } else {
          for (const part of block.content) {
            estimateToolResultPart(part, breakdown, warnings);
          }
        }
      } else {
        estimateMediaPart(block, breakdown, warnings);
      }
    }
  }

  for (const tool of options.tools ?? []) {
    breakdown.toolDefinitionTokens += estimateToolDefinition(tool, warnings);
  }

  return {
    totalTokens: sumBreakdown(breakdown),
    accuracy: 'heuristic',
    breakdown,
    warnings: [...warnings],
  };
}

const IMAGE_MAX_FALLBACK_TOKENS = 5_334;
const AUDIO_UNKNOWN_FALLBACK_TOKENS = 8_000;
const AUDIO_TOKENS_PER_SECOND = 32;
const DOCUMENT_UNKNOWN_FALLBACK_TOKENS = 8_000;
const DOCUMENT_TOKENS_PER_PAGE = 2_000;

function estimateMediaPart(
  part: ContentPart,
  breakdown: TokenEstimateBreakdown,
  warnings: Set<TokenEstimateWarningCode>,
): void {
  switch (part.type) {
    case 'image_data':
    case 'image_url':
      breakdown.imageTokens += estimateImageTokens(part.width, part.height, warnings);
      return;
    case 'audio_data':
      breakdown.audioTokens += estimateAudioTokens(part.durationMs, warnings);
      return;
    case 'file_data':
    case 'file_url':
      breakdown.documentTokens += estimateDocumentTokens(part.pageCount, warnings);
      return;
    case 'text':
      breakdown.textTokens += estimateTextTokens(part.text);
      return;
  }
}

function estimateToolResultPart(
  part: ToolResultContentPart,
  breakdown: TokenEstimateBreakdown,
  warnings: Set<TokenEstimateWarningCode>,
): void {
  if (part.type === 'text') {
    breakdown.textTokens += estimateTextTokens(part.text);
    return;
  }
  breakdown.imageTokens += estimateImageTokens(part.width, part.height, warnings);
}

function estimateImageTokens(
  width: number | undefined,
  height: number | undefined,
  warnings: Set<TokenEstimateWarningCode>,
): number {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    warnings.add('imageDimensionsUnknown');
    return IMAGE_MAX_FALLBACK_TOKENS;
  }
  return Math.min(
    IMAGE_MAX_FALLBACK_TOKENS,
    Math.max(85, Math.ceil((width * height) / 750)),
  );
}

function estimateAudioTokens(
  durationMs: number | undefined,
  warnings: Set<TokenEstimateWarningCode>,
): number {
  if (!isPositiveFinite(durationMs)) {
    warnings.add('audioDurationUnknown');
    return AUDIO_UNKNOWN_FALLBACK_TOKENS;
  }
  return Math.max(1, Math.ceil((durationMs / 1_000) * AUDIO_TOKENS_PER_SECOND));
}

function estimateDocumentTokens(
  pageCount: number | undefined,
  warnings: Set<TokenEstimateWarningCode>,
): number {
  if (!isPositiveFinite(pageCount)) {
    warnings.add('documentPageCountUnknown');
    return DOCUMENT_UNKNOWN_FALLBACK_TOKENS;
  }
  return Math.ceil(pageCount) * DOCUMENT_TOKENS_PER_PAGE;
}

function estimateToolDefinition(
  tool: TokenToolDefinition,
  warnings: Set<TokenEstimateWarningCode>,
): number {
  try {
    return 20 + estimateTextTokens(JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  } catch {
    warnings.add('toolDefinitionSerializationFailed');
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

function emptyBreakdown(): TokenEstimateBreakdown {
  return {
    textTokens: 0,
    messageEnvelopeTokens: 0,
    toolDefinitionTokens: 0,
    imageTokens: 0,
    audioTokens: 0,
    documentTokens: 0,
    otherTokens: 0,
  };
}

function sumBreakdown(breakdown: TokenEstimateBreakdown): number {
  return Object.values(breakdown).reduce((total, value) => total + value, 0);
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
