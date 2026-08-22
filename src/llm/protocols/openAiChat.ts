// 把中立请求转换为 OpenAI Chat Completions，并归一化其流事件。
import OpenAI from 'openai';
import {
  LlmStreamProtocolError,
  LlmToolArgumentsParseError,
  normalizeLlmProviderError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import type { ToolResultBlock } from '../message.js';
import type {
  AssistantBlock,
  LlmConnection,
  ContentPart,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmTool,
  Message,
  UserBlock,
} from '../types.js';
import { createLlmTokenUsage } from '../usage.js';

type CompatThinkingParam = { type: 'enabled' | 'disabled' };
type OpenAiChatParams =
  Omit<OpenAI.ChatCompletionCreateParamsStreaming, 'reasoning_effort'> & {
    thinking?: CompatThinkingParam;
    reasoning_effort?: 'low' | 'medium' | 'high' | 'max';
  };

export function createOpenAiChatProtocol(
  connection: LlmConnection, modelId: string,
): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  const client = new OpenAI({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    // 重试只能由调用方拥有，避免 SDK 与 Agent 各重试一次形成乘法放大。
    maxRetries: 0,
  });
  return (request) => streamOpenAiChat(client, modelId, request);
}

async function* streamOpenAiChat(
  client: OpenAI,
  modelId: string,
  request: LlmRequest,
): AsyncIterable<LlmStreamEvent> {
  const tools = request.tools?.map(toOpenAiTool);
  const params: OpenAiChatParams = {
    model: modelId,
    messages: toOpenAiMessages(request.messages),
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? toOpenAiToolChoice(request.toolChoice) : undefined,
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  applyThinking(params, request.thinking);

  let response: AsyncIterable<OpenAI.ChatCompletionChunk>;
  try {
    response = await client.chat.completions.create(
      params as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: request.signal },
    );
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLlmProviderError(error);
  }

  const toolBuffers = new Map<number, {
    id: string;
    name: string;
    argsJson: string;
    blockIndex: number;
  }>();
  let stopReason: LlmStopReason = 'end_turn';
  let receivedFinishReason = false;
  let nextBlockIndex = 0;
  let thinkingBlockIndex: number | undefined;
  let textBlockIndex: number | undefined;

  try {
    for await (const chunk of response) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      const extendedDelta = delta as Record<string, unknown> | undefined;

      if (typeof extendedDelta?.reasoning_content === 'string'
        && extendedDelta.reasoning_content.length > 0) {
        thinkingBlockIndex ??= nextBlockIndex++;
        yield {
          type: 'thinking_delta',
          blockIndex: thinkingBlockIndex,
          delta: extendedDelta.reasoning_content,
        };
      }

      if (delta?.content) {
        textBlockIndex ??= nextBlockIndex++;
        yield { type: 'text_delta', blockIndex: textBlockIndex, delta: delta.content };
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        let buffer = toolBuffers.get(toolCall.index);
        if (!buffer) {
          buffer = { id: '', name: '', argsJson: '', blockIndex: nextBlockIndex++ };
          toolBuffers.set(toolCall.index, buffer);
        }
        if (toolCall.id) buffer.id = toolCall.id;
        if (toolCall.function?.name) buffer.name = toolCall.function.name;
        if (toolCall.function?.arguments) {
          buffer.argsJson += toolCall.function.arguments;
          yield {
            type: 'tool_use_delta',
            blockIndex: buffer.blockIndex,
            callId: buffer.id,
            name: buffer.name,
            argsDelta: toolCall.function.arguments,
          };
        }
      }

      if (choice?.finish_reason) {
        receivedFinishReason = true;
        stopReason = mapStopReason(choice.finish_reason);
        for (const buffer of toolBuffers.values()) {
          let args: unknown;
          try {
            args = JSON.parse(buffer.argsJson);
          } catch (error) {
            throw new LlmToolArgumentsParseError(
              'openai-llm',
              buffer.id,
              buffer.name,
              buffer.argsJson,
              error,
            );
          }
          yield {
            type: 'tool_use_complete',
            blockIndex: buffer.blockIndex,
            callId: buffer.id,
            name: buffer.name,
            args,
          };
        }
        toolBuffers.clear();
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          ...createLlmTokenUsage({
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          }),
        };
      }
    }
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLlmProviderError(error);
  }

  throwIfAborted(request.signal);
  if (!receivedFinishReason) throw new LlmStreamProtocolError('openai-llm');
  yield { type: 'done', stopReason };
}

function toOpenAiMessages(
  messages: readonly Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      result.push({ role: 'system', content: message.content });
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        result.push({ role: 'user', content: message.content });
        continue;
      }
      const content: OpenAI.ChatCompletionContentPart[] = [];
      for (const block of message.content as readonly UserBlock[]) {
        if (block.type === 'tool_result') {
          if (content.length > 0) {
            result.push({ role: 'user', content: [...content] });
            content.length = 0;
          }
          const toolResult = block as ToolResultBlock;
          result.push({
            role: 'tool',
            tool_call_id: toolResult.toolCallId,
            content: typeof toolResult.content === 'string'
              ? toolResult.content
              : toolResult.content.map((part) => part.type === 'text' ? part.text : '').join('\n'),
          });
          continue;
        }
        content.push(toOpenAiContentPart(block as ContentPart));
      }
      if (content.length > 0) result.push({ role: 'user', content });
      continue;
    }

    let text = '';
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
    for (const block of message.content as readonly AssistantBlock[]) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.args) },
        });
      }
      // 中立 thinking 没有 Chat Completions 往返字段，按产品规则不跨协议重放。
    }
    result.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return result;
}

function toOpenAiContentPart(part: ContentPart): OpenAI.ChatCompletionContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image_url':
      return { type: 'image_url', image_url: { url: part.url } };
    case 'image_data':
      return {
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      };
    case 'audio_data':
      return {
        type: 'input_audio',
        input_audio: {
          data: part.data,
          format: part.mimeType === 'audio/wav' ? 'wav' : 'mp3',
        },
      } as OpenAI.ChatCompletionContentPart;
    case 'file_data':
    case 'file_url':
      throw new TypeError('openai-llm file content must be rejected before conversion');
  }
}

function toOpenAiTool(tool: LlmTool): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

function toOpenAiToolChoice(
  choice: LlmRequest['toolChoice'],
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function applyThinking(params: OpenAiChatParams, thinking: LlmRequest['thinking']): void {
  if (!thinking) return;
  if (thinking.enabled !== 'auto') {
    params.thinking = { type: thinking.enabled ? 'enabled' : 'disabled' };
  }
  if (thinking.enabled !== false && thinking.effort) {
    params.reasoning_effort = thinking.effort;
  }
}

function mapStopReason(reason: string): LlmStopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}
