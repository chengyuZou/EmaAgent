import OpenAI from 'openai';
import {
  createLLMProviderResponseError,
  LLMStreamProtocolError,
  LLMToolArgumentsParseError,
  normalizeLLMProviderError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import type { ContentPart, ToolResultBlock } from '../message.js';
import type {
  AssistantBlock,
  CompleteLLM,
  LLMConnection,
  LLMGenerationSource,
  LLMRequest,
  LLMStopReason,
  LLMStreamEvent,
  LLMTool,
  Message,
  UserBlock,
} from '../types.js';
import { createLLMTokenUsage } from '../usage.js';

type ResponseInput = OpenAI.Responses.ResponseInput;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;

/** 仅向原生成目标回传 reasoning ID 和加密内容, 不把其他模型的状态发给当前模型. */
function shouldReplayOpenAiReasoning(
  generatedBy: LLMGenerationSource | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return generatedBy?.protocol === 'openai-responses-llm'
    && generatedBy.providerId === providerId
    && generatedBy.modelId === modelId;
}

export function createOpenAiResponsesProtocol(
  connection: LLMConnection,
  modelId: string,
): (request: LLMRequest) => AsyncIterable<LLMStreamEvent> {
  const client = createOpenAiResponsesClient(connection);
  return (request) => streamOpenAiResponses(client, connection.providerId, modelId, request);
}

export function createOpenAiResponsesCompletion(
  connection: LLMConnection,
  modelId: string,
): CompleteLLM {
  const client = createOpenAiResponsesClient(connection);
  return async (request) => {
    try {
      const response = await client.responses.create(
        buildOpenAiResponsesParams(connection.providerId, modelId, request),
        { signal: request.signal },
      );
      throwIfAborted(request.signal);
      if (response.status !== 'completed' && response.status !== 'incomplete') {
        throw createLLMProviderResponseError({
          protocol: 'openai-responses-llm',
          providerCode: response.error?.code,
          message: response.error?.message ?? `Responses returned status ${response.status}`,
          cause: response,
        });
      }
      const blocks: AssistantBlock[] = [];
      let stopReason: LLMStopReason = 'end_turn';
      // output 可以交错出现思考, 正文和函数调用, 不能只读取 output_text.
      for (const item of response.output) {
        if (item.type === 'reasoning') {
          const summaryText = item.summary.map(part => part.text).join('');
          blocks.push({
            type: 'reasoning',
            id: item.id,
            ...(summaryText ? { summaryText } : {}),
            ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
          });
        } else if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type === 'output_text') blocks.push({ type: 'text', text: part.text });
            if (part.type === 'refusal') blocks.push({ type: 'text', text: part.refusal });
          }
        } else if (item.type === 'function_call') {
          let args: unknown;
          try {
            args = JSON.parse(item.arguments);
          } catch (error) {
            throw new LLMToolArgumentsParseError(
              'openai-responses-llm', item.call_id, item.name, error,
            );
          }
          blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, args });
          stopReason = 'tool_use';
        }
      }
      if (response.status === 'incomplete' && stopReason === 'end_turn') {
        stopReason = response.incomplete_details?.reason === 'max_output_tokens'
          ? 'max_tokens'
          : 'stop_sequence';
      }
      return {
        blocks,
        stopReason,
        usage: createLLMTokenUsage({
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          cacheReadInputTokens: response.usage?.input_tokens_details.cached_tokens,
        }),
      };
    } catch (error) {
      throwIfAbortError(error, request.signal);
      throw normalizeLLMProviderError(error);
    }
  };
}

function createOpenAiResponsesClient(connection: LLMConnection): OpenAI {
  return new OpenAI({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    maxRetries: 0,
  });
}

function buildOpenAiResponsesParams(
  providerId: string,
  modelId: string,
  request: LLMRequest,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const { instructions, input } = toResponsesInput(request.messages, providerId, modelId);
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: modelId,
    input,
    stream: false,
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
  };
  if (instructions) params.instructions = instructions;
  if (request.tools?.length && request.toolChoice !== 'none') {
    params.tools = request.tools.map(toResponsesTool);
    params.tool_choice = toResponsesToolChoice(request.toolChoice) as
      OpenAI.Responses.ResponseCreateParamsNonStreaming['tool_choice'];
  }
  if (request.thinking?.enabled === false) {
    params.reasoning = { effort: 'none' };
  } else if (request.thinking?.enabled === true) {
    // 请求供应商交付加密推理内容, 后续无需服务端会话也能回传原生 reasoning 状态.
    params.include = ['reasoning.encrypted_content'];
    if (request.thinking?.effort) {
      params.reasoning = {
        effort: request.thinking.effort,
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming['reasoning'];
    }
  }

  return params;
}

async function* streamOpenAiResponses(
  client: OpenAI,
  providerId: string,
  modelId: string,
  request: LLMRequest,
): AsyncIterable<LLMStreamEvent> {
  const params = {
    ...buildOpenAiResponsesParams(providerId, modelId, request),
    stream: true as const,
  };
  let stream: AsyncIterable<ResponseStreamEvent>;
  try {
    stream = await client.responses.create(params, { signal: request.signal });
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLLMProviderError(error);
  }

  let stopReason: LLMStopReason = 'end_turn';
  let nextBlockIndex = 0;
  let reasoningBlockIndex: number | undefined;
  let textBlockIndex: number | undefined;
  const toolCalls = new Map<number, {
    name: string;
    callId: string;
    blockIndex: number;
  }>();
  // 按 output_index 保存供应商的 reasoning ID 和加密内容, 完成时交给历史消息保存.
  const reasoningItems = new Map<number, {
    id: string;
    encryptedContent?: string;
    blockIndex: number;
  }>();

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'response.reasoning_summary_text.delta': {
          const item = reasoningItems.get(event.output_index);
          if (item) {
            yield { type: 'thinking_delta', blockIndex: item.blockIndex, delta: event.delta };
          } else {
            reasoningBlockIndex ??= nextBlockIndex++;
            yield {
              type: 'thinking_delta',
              blockIndex: reasoningBlockIndex,
              delta: event.delta,
            };
          }
          break;
        }
        case 'response.output_text.delta':
          textBlockIndex ??= nextBlockIndex++;
          yield { type: 'text_delta', blockIndex: textBlockIndex, delta: event.delta };
          break;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') {
            toolCalls.set(event.output_index, {
              name: event.item.name,
              callId: event.item.call_id,
              blockIndex: nextBlockIndex++,
            });
          }
          if (event.item.type === 'reasoning') {
            reasoningItems.set(event.output_index, {
              id: event.item.id,
              ...(event.item.encrypted_content
                ? { encryptedContent: event.item.encrypted_content }
                : {}),
              blockIndex: nextBlockIndex++,
            });
          }
          break;
        case 'response.function_call_arguments.delta': {
          const toolCall = toolCalls.get(event.output_index);
          if (toolCall) {
            yield {
              type: 'tool_use_delta',
              blockIndex: toolCall.blockIndex,
              callId: toolCall.callId,
              name: toolCall.name,
              argsDelta: event.delta,
            };
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const toolCall = toolCalls.get(event.output_index);
          if (toolCall) {
            let args: unknown;
            try {
              args = JSON.parse(event.arguments);
            } catch (error) {
              throw new LLMToolArgumentsParseError(
                'openai-responses-llm',
                toolCall.callId,
                toolCall.name,
                error,
              );
            }
            yield {
              type: 'tool_use_complete',
              blockIndex: toolCall.blockIndex,
              callId: toolCall.callId,
              name: toolCall.name,
              args,
            };
            stopReason = 'tool_use';
            toolCalls.delete(event.output_index);
          }
          break;
        }
        case 'response.output_item.done': {
          const item = reasoningItems.get(event.output_index);
          if (item && event.item.type === 'reasoning') {
            const encryptedContent = event.item.encrypted_content || item.encryptedContent;
            yield {
              type: 'thinking_complete',
              blockIndex: item.blockIndex,
              state: {
                kind: 'openai',
                id: event.item.id,
                ...(encryptedContent ? { encryptedContent } : {}),
              },
            };
            reasoningItems.delete(event.output_index);
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const usage = event.response.usage;
          if (usage) {
            yield {
              type: 'usage',
              ...createLLMTokenUsage({
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadInputTokens: usage.input_tokens_details.cached_tokens,
              }),
            };
          }
          if (event.type === 'response.incomplete' && stopReason === 'end_turn') {
            const reason = event.response.incomplete_details?.reason;
            stopReason = reason === 'max_output_tokens' ? 'max_tokens' : 'stop_sequence';
          }
          throwIfAborted(request.signal);
          yield { type: 'done', stopReason };
          return;
        }
        case 'response.failed':
          throw createLLMProviderResponseError({
            protocol: 'openai-responses-llm',
            providerCode: event.response.error?.code,
            message: event.response.error?.message
              ?? 'OpenAI Responses API reported a failed response',
            cause: event,
          });
        case 'error':
          throw createLLMProviderResponseError({
            protocol: 'openai-responses-llm',
            providerCode: event.code,
            message: event.message,
            cause: event,
          });
        default:
          break;
      }
    }
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLLMProviderError(error);
  }

  throwIfAborted(request.signal);
  throw new LLMStreamProtocolError('openai-responses-llm');
}

export function toResponsesInput(
  messages: readonly Message[],
  providerId: string,
  modelId: string,
): { instructions: string | undefined; input: ResponseInput } {
  const input: ResponseInputItem[] = [];
  let instructions: string | undefined;

  for (const message of messages) {
    if (message.role === 'system') {
      instructions = instructions
        ? `${instructions}\n\n${message.content}`
        : message.content;
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        input.push({ role: 'user', content: message.content });
        continue;
      }
      const content: OpenAI.Responses.ResponseInputContent[] = [];
      for (const block of message.content as readonly UserBlock[]) {
        if (block.type === 'tool_result') {
          if (content.length > 0) {
            input.push({ role: 'user', content: [...content] });
            content.length = 0;
          }
          const toolResult = block as ToolResultBlock;
          input.push({
            type: 'function_call_output',
            call_id: toolResult.toolCallId,
            output: typeof toolResult.content === 'string'
              ? toolResult.content
              : toolResult.content.map(toResponsesContent),
          });
          continue;
        }
        content.push(toResponsesContent(block as ContentPart));
      }
      if (content.length > 0) input.push({ role: 'user', content });
      continue;
    }

    let text = '';
    const calls: OpenAI.Responses.ResponseFunctionToolCall[] = [];
    const reasoning: ResponseInputItem[] = [];
    // 原生状态只回传给原生成目标, 正文和工具调用照常发送.
    const replayReasoning = shouldReplayOpenAiReasoning(message.generatedBy, providerId, modelId);
    for (const block of message.content as readonly AssistantBlock[]) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'reasoning' && replayReasoning) {
        reasoning.push({
          type: 'reasoning',
          id: block.id,
          ...(block.encryptedContent
            ? { encrypted_content: block.encryptedContent }
            : {}),
          summary: block.summaryText
            ? [{ type: 'summary_text', text: block.summaryText }]
            : [],
        } as ResponseInputItem);
      }
      if (block.type === 'tool_use') {
        calls.push({
          type: 'function_call',
          id: block.id,
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.args),
        });
      }
    }
    input.push(...reasoning);
    if (text) input.push({ role: 'assistant', content: text });
    input.push(...calls as ResponseInputItem[]);
  }
  return { instructions, input };
}

function toResponsesContent(part: ContentPart): OpenAI.Responses.ResponseInputContent {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text };
    case 'image_url':
      return { type: 'input_image', detail: 'auto', image_url: part.url };
    case 'image_data':
      return {
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${part.mimeType};base64,${part.data}`,
      };
    case 'file_data':
      return {
        type: 'input_file',
        file_data: `data:${part.mimeType};base64,${part.data}`,
        filename: part.filename,
      };
    case 'file_url':
      return {
        type: 'input_file',
        file_url: part.url,
      } as OpenAI.Responses.ResponseInputContent;
    case 'audio_data':
      throw new TypeError('openai-responses-llm audio must be rejected before conversion');
  }
}

function toResponsesTool(tool: LLMTool): OpenAI.Responses.FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
    strict: true,
  };
}

function toResponsesToolChoice(
  choice: LLMRequest['toolChoice'],
): OpenAI.Responses.ToolChoiceOptions | OpenAI.Responses.ToolChoiceFunction | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}
