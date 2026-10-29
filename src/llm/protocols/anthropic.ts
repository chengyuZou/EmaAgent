import Anthropic from '@anthropic-ai/sdk';
import {
  LLMStreamProtocolError,
  LLMToolArgumentsParseError,
  normalizeLLMProviderError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import type {
  ContentPart,
  ToolResultBlock,
  ToolResultContentPart,
  UserBlock,
} from '../message.js';
import type {
  AssistantBlock,
  LLMConnection,
  LLMGenerationSource,
  LLMRequest,
  LLMStopReason,
  LLMStreamEvent,
  LLMThinking,
  LLMThinkingEffort,
  LLMTokenUsage,
  LLMTool,
  Message,
} from '../types.js';
import { createLLMTokenUsage } from '../usage.js';

/** 仅向生成签名的同一供应商, 模型和协议回传思考状态. */
function shouldReplayAnthropicThinking(
  generatedBy: LLMGenerationSource | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return generatedBy?.protocol === 'anthropic-llm'
    && generatedBy.providerId === providerId
    && generatedBy.modelId === modelId;
}

// 当前实现使用 budget_tokens 格式, 预算至少为 1024, 且必须小于 max_tokens.
const MIN_THINKING_BUDGET_TOKENS = 1_024;
const DEFAULT_THINKING_BUDGET_TOKENS = 8_000;
// 本项目将强度换算为预算的取值, 不表示与其他供应商的同名档位等效.
const EFFORT_BUDGET_TOKENS: Record<LLMThinkingEffort, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  max: 32_000,
};

/**
 * 优先使用显式 budgetTokens, 其次按 effort 换算, 都没有时使用默认预算.
 * 预算限制在 1024 到 max_tokens - 1, 输出上限无法容纳最小预算时拒绝请求.
 */
export function buildAnthropicThinking(
  thinking: LLMThinking | undefined,
  maxOutputTokens: number,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (thinking?.enabled !== true) return undefined;
  if (maxOutputTokens <= MIN_THINKING_BUDGET_TOKENS) {
    throw new TypeError(
      `thinking 需要 maxOutputTokens > ${MIN_THINKING_BUDGET_TOKENS}（当前 ${maxOutputTokens}）`,
    );
  }
  const desired = thinking.budgetTokens
    ?? (thinking.effort ? EFFORT_BUDGET_TOKENS[thinking.effort] : DEFAULT_THINKING_BUDGET_TOKENS);
  return {
    type: 'enabled',
    budget_tokens: Math.max(
      MIN_THINKING_BUDGET_TOKENS,
      Math.min(desired, maxOutputTokens - 1),
    ),
  };
}

export function createAnthropicProtocol(
  connection: LLMConnection,
  modelId: string,
): (request: LLMRequest) => AsyncIterable<LLMStreamEvent> {
  const client = createAnthropicClient(connection);
  return (request) => streamAnthropic(client, connection.providerId, modelId, request);
}

function createAnthropicClient(connection: LLMConnection): Anthropic {
  return new Anthropic({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    maxRetries: 0,
  });
}

function buildAnthropicBody(
  providerId: string,
  modelId: string,
  request: LLMRequest,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  if (request.maxOutputTokens === undefined) {
    throw new TypeError('anthropic-llm requires maxOutputTokens');
  }
  const { system, messages } = toAnthropicMessages(request.messages, providerId, modelId);
  const tools = request.toolChoice === 'none'
    ? undefined
    : request.tools?.map(toAnthropicTool);
  const thinkingEnabled = request.thinking?.enabled === true;
  const thinking = buildAnthropicThinking(request.thinking, request.maxOutputTokens);
  return {
    model: modelId,
    messages,
    max_tokens: request.maxOutputTokens,
    temperature: thinkingEnabled ? 1 : request.temperature,
    ...(system ? { system } : {}),
    ...(tools?.length
      ? { tools, tool_choice: toAnthropicToolChoice(request.toolChoice) }
      : {}),
    ...(thinking ? { thinking } : {}),
  };
}

async function* streamAnthropic(
  client: Anthropic,
  providerId: string,
  modelId: string,
  request: LLMRequest,
): AsyncIterable<LLMStreamEvent> {
  const body = buildAnthropicBody(providerId, modelId, request);
  const thinkingEnabled = request.thinking?.enabled === true;
  let stream: AsyncIterable<Anthropic.MessageStreamEvent>;
  try {
    stream = client.messages.stream(body, {
      signal: request.signal,
      headers: thinkingEnabled
        ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
        : undefined,
    });
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLLMProviderError(error);
  }

  const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
  const thinkingSignatures = new Map<number, string>();
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | null | undefined;
  let cacheWriteInputTokens: number | null | undefined;
  let stopReason: LLMStopReason = 'end_turn';
  let receivedMessageStop = false;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          uncachedInputTokens = event.message.usage.input_tokens;
          cacheReadInputTokens = event.message.usage.cache_read_input_tokens;
          cacheWriteInputTokens = event.message.usage.cache_creation_input_tokens;
          yield {
            type: 'usage',
            ...createAnthropicUsage(
              uncachedInputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheWriteInputTokens,
            ),
          };
          break;
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              argsJson: '',
            });
          } else if (event.content_block.type === 'thinking') {
            thinkingSignatures.set(event.index, '');
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', blockIndex: event.index, delta: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield {
              type: 'thinking_delta',
              blockIndex: event.index,
              delta: event.delta.thinking,
            };
          } else if (event.delta.type === 'signature_delta') {
            thinkingSignatures.set(
              event.index,
              (thinkingSignatures.get(event.index) ?? '') + event.delta.signature,
            );
          } else if (event.delta.type === 'input_json_delta') {
            const toolBlock = toolBlocks.get(event.index);
            if (toolBlock) {
              toolBlock.argsJson += event.delta.partial_json;
              yield {
                type: 'tool_use_delta',
                blockIndex: event.index,
                callId: toolBlock.id,
                name: toolBlock.name,
                argsDelta: event.delta.partial_json,
              };
            }
          }
          break;
        case 'content_block_stop': {
          const toolBlock = toolBlocks.get(event.index);
          if (toolBlock) {
            let args: unknown;
            try {
              args = JSON.parse(toolBlock.argsJson);
            } catch (error) {
              throw new LLMToolArgumentsParseError(
                'anthropic-llm',
                toolBlock.id,
                toolBlock.name,
                error,
              );
            }
            yield {
              type: 'tool_use_complete',
              blockIndex: event.index,
              callId: toolBlock.id,
              name: toolBlock.name,
              args,
            };
            toolBlocks.delete(event.index);
          }
          if (thinkingSignatures.has(event.index)) {
            const signature = thinkingSignatures.get(event.index);
            yield {
              type: 'thinking_complete',
              blockIndex: event.index,
              ...(signature
                ? { state: { kind: 'anthropic' as const, signature } }
                : {}),
            };
            thinkingSignatures.delete(event.index);
          }
          break;
        }
        case 'message_delta':
          outputTokens = event.usage.output_tokens;
          stopReason = mapStopReason(event.delta.stop_reason);
          yield {
            type: 'usage',
            ...createAnthropicUsage(
              uncachedInputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheWriteInputTokens,
            ),
          };
          break;
        case 'message_stop':
          receivedMessageStop = true;
          break;
        default:
          break;
      }
    }
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLLMProviderError(error);
  }

  throwIfAborted(request.signal);
  if (!receivedMessageStop) throw new LLMStreamProtocolError('anthropic-llm');
  yield {
    type: 'usage',
    ...createAnthropicUsage(
      uncachedInputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
    ),
  };
  yield { type: 'done', stopReason };
}

interface AnthropicMessages {
  system: Anthropic.MessageCreateParams['system'];
  messages: Anthropic.MessageParam[];
}

export function toAnthropicMessages(
  messages: readonly Message[],
  providerId: string,
  modelId: string,
): AnthropicMessages {
  const system: Anthropic.TextBlockParam[] = [];
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      system.push({
        type: 'text',
        text: message.content,
        ...(message.cacheBreakpoint
          ? { cache_control: { type: 'ephemeral' as const } }
          : {}),
      });
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        appendAnthropicUser(result, message.cacheBreakpoint
          ? [{
              type: 'text',
              text: message.content,
              cache_control: { type: 'ephemeral' },
            }]
          : message.content);
        continue;
      }
      const content: Anthropic.ContentBlockParam[] = [];
      for (const block of message.content as readonly UserBlock[]) {
        if (block.type === 'tool_result') {
          const toolResult = block as ToolResultBlock;
          content.push({
            type: 'tool_result',
            tool_use_id: toolResult.toolCallId,
            content: typeof toolResult.content === 'string'
              ? toolResult.content
              : toolResult.content.map(toAnthropicToolResultPart),
            is_error: toolResult.isError,
          });
        } else {
          content.push(toAnthropicContentPart(block as ContentPart));
        }
      }
      setLastCacheBreakpoint(content, message.cacheBreakpoint);
      appendAnthropicUser(result, content);
      continue;
    }

    const content: Anthropic.ContentBlockParam[] = [];
    // 签名只回传给原生成目标, 正文和工具调用不受此检查影响.
    const replayThinking = shouldReplayAnthropicThinking(message.generatedBy, providerId, modelId);
    for (const block of message.content as readonly AssistantBlock[]) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      if (block.type === 'thinking' && block.signature && replayThinking) {
        content.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        } as Anthropic.ContentBlockParam);
      }
      if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.args as Record<string, unknown>,
        });
      }
    }
    setLastCacheBreakpoint(content, message.cacheBreakpoint);
    result.push({ role: 'assistant', content });
  }
  return { system: system.length > 0 ? system : undefined, messages: result };
}

function appendAnthropicUser(
  messages: Anthropic.MessageParam[],
  content: string | Anthropic.ContentBlockParam[],
): void {
  // 工具结果可分别保存成消息, 发送时合并相邻 user 消息以保持工具回复在同一批次.
  const previous = messages.at(-1);
  if (previous?.role !== 'user') {
    messages.push({ role: 'user', content });
    return;
  }
  const previousBlocks: Anthropic.ContentBlockParam[] = typeof previous.content === 'string'
    ? [{ type: 'text', text: previous.content }]
    : [...previous.content];
  const nextBlocks: Anthropic.ContentBlockParam[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;
  messages[messages.length - 1] = {
    role: 'user',
    content: [...previousBlocks, ...nextBlocks],
  };
}

function toAnthropicContentPart(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image_url':
      return { type: 'image', source: { type: 'url', url: part.url } };
    case 'image_data':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'],
          data: part.data,
        },
      };
    case 'file_data':
      return {
        type: 'document',
        source: { type: 'base64', media_type: part.mimeType, data: part.data },
      } as Anthropic.ContentBlockParam;
    case 'file_url':
      return {
        type: 'document',
        source: { type: 'url', url: part.url },
      } as Anthropic.ContentBlockParam;
    case 'audio_data':
      throw new TypeError('anthropic-llm audio must be rejected before conversion');
  }
}

function toAnthropicToolResultPart(
  part: ToolResultContentPart,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image_url') {
    return { type: 'image', source: { type: 'url', url: part.url } };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'],
      data: part.data,
    },
  };
}

function setLastCacheBreakpoint(
  content: Anthropic.ContentBlockParam[],
  enabled: true | undefined,
): void {
  if (!enabled || content.length === 0) return;
  const last = content.pop()!;
  content.push({
    ...last,
    cache_control: { type: 'ephemeral' },
  } as Anthropic.ContentBlockParam);
}

function toAnthropicTool(tool: LLMTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', ...tool.inputSchema } as Anthropic.Tool['input_schema'],
  };
}

function toAnthropicToolChoice(
  choice: LLMRequest['toolChoice'],
): Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceAny | Anthropic.ToolChoiceTool | undefined {
  if (choice === undefined || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return undefined;
  return { type: 'tool', name: choice.name };
}

function createAnthropicUsage(
  uncachedInputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number | null | undefined,
  cacheWriteInputTokens: number | null | undefined,
): LLMTokenUsage {
  const inputTokens = uncachedInputTokens
    + (cacheReadInputTokens ?? 0)
    + (cacheWriteInputTokens ?? 0);
  return createLLMTokenUsage({
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  });
}

function mapStopReason(reason: string | null | undefined): LLMStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}
