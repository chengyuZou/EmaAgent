import OpenAI from 'openai';
import {
  createLLMProviderResponseError,
  LLMStreamProtocolError,
  LLMToolArgumentsParseError,
  normalizeLLMProviderError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import type { ToolResultBlock } from '../message.js';
import type {
  AssistantBlock,
  CompleteLLM,
  LLMConnection,
  ContentPart,
  LLMRequest,
  LLMStopReason,
  LLMStreamEvent,
  LLMTool,
  Message,
  UserBlock,
} from '../types.js';
import { createLLMTokenUsage } from '../usage.js';

type CompatThinkingParam = { type: 'enabled' | 'disabled' };
type OpenAiChatParams =
  Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'reasoning_effort'> & {
    thinking?: CompatThinkingParam;
    reasoning_effort?: 'low' | 'medium' | 'high' | 'max';
  };

const STREAM_IDLE_TIMEOUT_MS = 60_000;
const USAGE_TAIL_TIMEOUT_MS = 2_000;

export function createOpenAiChatProtocol(
  connection: LLMConnection,
  modelId: string,
): (request: LLMRequest) => AsyncIterable<LLMStreamEvent> {
  const client = createOpenAiChatClient(connection);
  return (request) => streamOpenAiChat(client, modelId, request);
}

export function createOpenAiChatCompletion(
  connection: LLMConnection,
  modelId: string,
): CompleteLLM {
  const client = createOpenAiChatClient(connection);
  return async (request) => {
    try {
      const response = await client.chat.completions.create(
        buildOpenAiChatParams(modelId, request) as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal: request.signal },
      );
      throwIfAborted(request.signal);
      const choice = response.choices[0];
      if (!choice?.finish_reason) {
        throw createLLMProviderResponseError({
          protocol: 'openai-llm',
          message: 'Chat Completions returned no choice with a finish reason',
          cause: response,
        });
      }
      const blocks: AssistantBlock[] = [];
      const message = choice.message as OpenAI.ChatCompletionMessage & {
        reasoning_content?: string;
      };
      if (message.reasoning_content) {
        blocks.push({ type: 'thinking', thinking: message.reasoning_content });
      }
      if (message.content) blocks.push({ type: 'text', text: message.content });
      if (message.refusal) blocks.push({ type: 'text', text: message.refusal });
      for (const tool of message.tool_calls ?? []) {
        if (tool.type !== 'function') continue;
        let args: unknown;
        try {
          args = JSON.parse(tool.function.arguments);
        } catch (error) {
          throw new LLMToolArgumentsParseError('openai-llm', tool.id, tool.function.name, error);
        }
        blocks.push({ type: 'tool_use', id: tool.id, name: tool.function.name, args });
      }
      return {
        blocks,
        stopReason: mapStopReason(choice.finish_reason),
        usage: createLLMTokenUsage({
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          cacheReadInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
        }),
      };
    } catch (error) {
      throwIfAbortError(error, request.signal);
      throw normalizeLLMProviderError(error);
    }
  };
}

function createOpenAiChatClient(connection: LLMConnection): OpenAI {
  return new OpenAI({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    // 调用方决定是否重试, 避免 SDK 再次发送同一计费请求.
    maxRetries: 0,
  });
}

function buildOpenAiChatParams(
  modelId: string,
  request: LLMRequest,
): OpenAiChatParams {
  const tools = request.tools?.map(toOpenAiTool);
  const params: OpenAiChatParams = {
    model: modelId,
    messages: toOpenAiMessages(request.messages),
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? toOpenAiToolChoice(request.toolChoice) : undefined,
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    stream: false,
  };
  applyThinking(params, request.thinking);
  return params;
}

async function* streamOpenAiChat(
  client: OpenAI,
  modelId: string,
  request: LLMRequest,
): AsyncIterable<LLMStreamEvent> {
  const params = {
    ...buildOpenAiChatParams(modelId, request),
    stream: true,
    stream_options: { include_usage: true },
  };

  const streamAbort = new AbortController();
  const streamSignal = request.signal
    ? AbortSignal.any([request.signal, streamAbort.signal])
    : streamAbort.signal;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (delayMs: number): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => streamAbort.abort('openai_stream_idle'), delayMs);
  };

  let response: AsyncIterable<OpenAI.ChatCompletionChunk>;
  try {
    armIdleTimer(STREAM_IDLE_TIMEOUT_MS);
    response = await client.chat.completions.create(
      params as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: streamSignal },
    );
  } catch (error) {
    clearTimeout(idleTimer);
    if (request.signal?.aborted) throwIfAbortError(error, request.signal);
    if (streamAbort.signal.aborted) throw new LLMStreamProtocolError('openai-llm');
    throw normalizeLLMProviderError(error);
  }

  const toolBuffers = new Map<number, {
    id: string;
    name: string;
    argsJson: string;
    blockIndex: number;
  }>();
  let stopReason: LLMStopReason = 'end_turn';
  let receivedFinishReason = false;
  let nextBlockIndex = 0;
  let thinkingBlockIndex: number | undefined;
  let textBlockIndex: number | undefined;

  try {
    for await (const chunk of response) {
      // finish_reason 后仍可能到达用量, 只短暂等待尾帧, 不让已完成的正文一直挂起.
      armIdleTimer(receivedFinishReason ? USAGE_TAIL_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS);
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
        armIdleTimer(USAGE_TAIL_TIMEOUT_MS);
        stopReason = mapStopReason(choice.finish_reason);
        for (const buffer of toolBuffers.values()) {
          let args: unknown;
          try {
            args = JSON.parse(buffer.argsJson);
          } catch (error) {
            throw new LLMToolArgumentsParseError(
              'openai-llm',
              buffer.id,
              buffer.name,
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
          ...createLLMTokenUsage({
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          }),
        };
        if (receivedFinishReason) break;
      }
    }
  } catch (error) {
    if (request.signal?.aborted) throwIfAbortError(error, request.signal);
    if (streamAbort.signal.aborted) {
      if (!receivedFinishReason) throw new LLMStreamProtocolError('openai-llm');
    } else {
      throw normalizeLLMProviderError(error);
    }
  } finally {
    clearTimeout(idleTimer);
  }

  throwIfAborted(request.signal);
  if (!receivedFinishReason) throw new LLMStreamProtocolError('openai-llm');
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
            content: toOpenAiToolResultContent(toolResult),
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
      // 当前 Chat 转换不回传历史思考, 只发送普通正文和工具调用.
    }
    result.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return result;
}

function toOpenAiToolResultContent(toolResult: ToolResultBlock): string {
  if (typeof toolResult.content === 'string') return toolResult.content;
  // Chat 的 tool 回复只能放文字. 图片在原位置占位, 不另补 user 消息或调用 Vision.
  return toolResult.content
    .map(part => {
      if (part.type === 'text') return part.text;
      return '[工具图片未提供: 当前 Chat Completions 工具回复不支持图片, 本次未读取图片内容. '
        + '如任务需要这张图片, 可使用 DescribeImage 获取文字描述(若工具可用), '
        + '或建议用户切换到支持工具图片的协议和视觉模型.]';
    })
    .join('\n');
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

function toOpenAiTool(tool: LLMTool): OpenAI.ChatCompletionTool {
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
  choice: LLMRequest['toolChoice'],
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function applyThinking(params: OpenAiChatParams, thinking: LLMRequest['thinking']): void {
  if (!thinking) return;
  if (thinking.enabled !== 'auto') {
    params.thinking = { type: thinking.enabled ? 'enabled' : 'disabled' };
  }
  if (thinking.enabled !== false && thinking.effort) {
    params.reasoning_effort = thinking.effort;
  }
}

function mapStopReason(reason: string): LLMStopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}
