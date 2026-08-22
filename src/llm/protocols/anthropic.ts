// 把中立请求转换为 Anthropic Messages，并保留原生 block 顺序与缓存断点。
import Anthropic from '@anthropic-ai/sdk';
import {
  LlmStreamProtocolError,
  LlmToolArgumentsParseError,
  normalizeLlmProviderError,
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
  LlmConnection,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmTokenUsage,
  LlmTool,
  Message,
} from '../types.js';
import { createLlmTokenUsage } from '../usage.js';

export function createAnthropicProtocol(
  connection: LlmConnection, modelId: string,
): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  const client = new Anthropic({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    maxRetries: 0,
  });
  return (request) => streamAnthropic(client, modelId, request);
}

async function* streamAnthropic(
  client: Anthropic,
  modelId: string,
  request: LlmRequest,
): AsyncIterable<LlmStreamEvent> {
  if (request.maxOutputTokens === undefined) {
    throw new TypeError('anthropic-llm requires maxOutputTokens');
  }
  const { system, messages } = toAnthropicMessages(request.messages);
  const tools = request.toolChoice === 'none'
    ? undefined
    : request.tools?.map(toAnthropicTool);
  const thinkingEnabled = request.thinking?.enabled === true;
  const body: Anthropic.Messages.MessageStreamParams = {
    model: modelId,
    messages,
    max_tokens: request.maxOutputTokens,
    temperature: thinkingEnabled ? 1 : request.temperature,
    ...(system ? { system } : {}),
    ...(tools?.length
      ? { tools, tool_choice: toAnthropicToolChoice(request.toolChoice) }
      : {}),
    ...(thinkingEnabled
      ? {
          thinking: {
            type: 'enabled' as const,
            budget_tokens: request.thinking?.budgetTokens ?? 8_000,
          },
        }
      : {}),
  };

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
    throw normalizeLlmProviderError(error);
  }

  const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
  const thinkingSignatures = new Map<number, string>();
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | null | undefined;
  let cacheWriteInputTokens: number | null | undefined;
  let stopReason: LlmStopReason = 'end_turn';
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
              throw new LlmToolArgumentsParseError(
                'anthropic-llm',
                toolBlock.id,
                toolBlock.name,
                toolBlock.argsJson,
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
              ...(signature ? { signature } : {}),
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
    throw normalizeLlmProviderError(error);
  }

  throwIfAborted(request.signal);
  if (!receivedMessageStop) throw new LlmStreamProtocolError('anthropic-llm');
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

export function toAnthropicMessages(messages: readonly Message[]): AnthropicMessages {
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
        result.push(message.cacheBreakpoint
          ? {
              role: 'user',
              content: [{
                type: 'text',
                text: message.content,
                cache_control: { type: 'ephemeral' },
              }],
            }
          : { role: 'user', content: message.content });
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
      result.push({ role: 'user', content });
      continue;
    }

    const content: Anthropic.ContentBlockParam[] = [];
    for (const block of message.content as readonly AssistantBlock[]) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      if (block.type === 'thinking' && block.signature) {
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

function toAnthropicTool(tool: LlmTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', ...tool.inputSchema } as Anthropic.Tool['input_schema'],
  };
}

function toAnthropicToolChoice(
  choice: LlmRequest['toolChoice'],
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
): LlmTokenUsage {
  const inputTokens = uncachedInputTokens
    + (cacheReadInputTokens ?? 0)
    + (cacheWriteInputTokens ?? 0);
  return createLlmTokenUsage({
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    cacheEligibleInputTokens: inputTokens,
  });
}

function mapStopReason(reason: string | null | undefined): LlmStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}
