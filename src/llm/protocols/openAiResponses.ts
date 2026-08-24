// 把中立请求转换为 OpenAI Responses API，并使用其显式终态归一化流。
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import {
  createLlmProviderResponseError,
  LlmStreamProtocolError,
  LlmToolArgumentsParseError,
  normalizeLlmProviderError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import type { ContentPart, ToolResultBlock } from '../message.js';
import type {
  AssistantBlock,
  LlmConnection,
  LlmGenerationSource,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmTool,
  Message,
  UserBlock,
} from '../types.js';
import { createLlmTokenUsage } from '../usage.js';

type ResponseInput = OpenAI.Responses.ResponseInput;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;

/** 只重放本模型生成的 reasoning：OpenAI 的 reasoning 模型私有，无来源/跨协议/跨模型都删除。 */
function shouldReplayOpenAiReasoning(
  generatedBy: LlmGenerationSource | undefined,
  modelId: string,
): boolean {
  return generatedBy?.protocol === 'openai-responses-llm' && generatedBy.modelId === modelId;
}

export function createOpenAiResponsesProtocol(
  connection: LlmConnection, modelId: string,
): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  const client = new OpenAI({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    maxRetries: 0,
  });
  return (request) => streamOpenAiResponses(client, modelId, request);
}

async function* streamOpenAiResponses(
  client: OpenAI,
  modelId: string,
  request: LlmRequest,
): AsyncIterable<LlmStreamEvent> {
  const { instructions, input } = toResponsesInput(request.messages, modelId);
  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    model: modelId,
    input,
    stream: true,
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
  };
  if (instructions) params.instructions = instructions;
  if (request.tools?.length && request.toolChoice !== 'none') {
    params.tools = request.tools.map(toResponsesTool);
    params.tool_choice = toResponsesToolChoice(request.toolChoice) as
      OpenAI.Responses.ResponseCreateParamsStreaming['tool_choice'];
  }
  if (request.thinking?.enabled !== false && request.thinking?.effort) {
    params.reasoning = {
      effort: request.thinking.effort,
    } as OpenAI.Responses.ResponseCreateParamsStreaming['reasoning'];
  }

  let stream: AsyncIterable<ResponseStreamEvent>;
  try {
    stream = await client.responses.create(params, { signal: request.signal });
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLlmProviderError(error);
  }

  let stopReason: LlmStopReason = 'end_turn';
  let nextBlockIndex = 0;
  let reasoningBlockIndex: number | undefined;
  let textBlockIndex: number | undefined;
  const toolCalls = new Map<number, {
    name: string;
    callId: string;
    blockIndex: number;
  }>();

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'response.reasoning_summary_text.delta':
          reasoningBlockIndex ??= nextBlockIndex++;
          yield {
            type: 'thinking_delta',
            blockIndex: reasoningBlockIndex,
            delta: event.delta,
          };
          break;
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
              throw new LlmToolArgumentsParseError(
                'openai-responses-llm',
                toolCall.callId,
                toolCall.name,
                event.arguments,
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
        case 'response.completed':
        case 'response.incomplete': {
          const usage = event.response.usage;
          if (usage) {
            yield {
              type: 'usage',
              ...createLlmTokenUsage({
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
          throw createLlmProviderResponseError({
            protocol: 'openai-responses-llm',
            providerCode: event.response.error?.code,
            message: event.response.error?.message
              ?? 'OpenAI Responses API reported a failed response',
            cause: event,
          });
        case 'error':
          throw createLlmProviderResponseError({
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
    throw normalizeLlmProviderError(error);
  }

  throwIfAborted(request.signal);
  throw new LlmStreamProtocolError('openai-responses-llm');
}

export function toResponsesInput(
  messages: readonly Message[],
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
              : toolResult.content.map((part) => part.type === 'text' ? part.text : '').join('\n'),
          } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
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
    // reasoning 只随生成它的同一个模型重放（reasoning 模型私有）；无来源、跨协议或
    // 跨模型的历史 thinking 一律删除。V1 重放 summary 结构（encrypted_content 收集留后）。
    const replayReasoning = shouldReplayOpenAiReasoning(message.generatedBy, modelId);
    for (const block of message.content as readonly AssistantBlock[]) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'thinking' && replayReasoning) {
        reasoning.push({
          type: 'reasoning',
          id: randomUUID(),
          summary: [{ type: 'summary_text', text: block.thinking }],
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

function toResponsesTool(tool: LlmTool): OpenAI.Responses.FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
    strict: true,
  };
}

function toResponsesToolChoice(
  choice: LlmRequest['toolChoice'],
): OpenAI.Responses.ToolChoiceOptions | OpenAI.Responses.ToolChoiceFunction | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}
