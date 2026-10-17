import {
  FunctionCallingConfigMode,
  GoogleGenAI,
} from '@google/genai';
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
  ThinkingConfig,
  ToolConfig,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import {
  createLLMProviderResponseError,
  LLMStreamProtocolError,
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
  LLMThinking,
  LLMThinkingEffort,
  LLMTool,
  Message,
  UserBlock,
} from '../types.js';
import { createLLMTokenUsage } from '../usage.js';

/** 仅向生成签名的同一供应商, 模型和协议回传思考状态. */
function shouldReplayGeminiThought(
  generatedBy: LLMGenerationSource | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return generatedBy?.protocol === 'gemini-llm'
    && generatedBy.providerId === providerId
    && generatedBy.modelId === modelId;
}

const DEFAULT_THINKING_BUDGET_TOKENS = 8_000;
// 本项目将强度换算为预算的取值, 不表示与其他供应商的同名档位等效.
const EFFORT_BUDGET_TOKENS: Record<LLMThinkingEffort, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  max: 32_000,
};

/**
 * 关闭时发送 thinkingBudget: 0. 开启时优先使用 budgetTokens, 其次 effort, 最后默认预算.
 * 给出输出上限时, 思考预算至多为 maxOutputTokens - 1, 为正文留出输出空间.
 */
export function buildGeminiThinkingConfig(
  thinking: LLMThinking | undefined,
  maxOutputTokens: number | undefined,
): ThinkingConfig | undefined {
  if (thinking?.enabled === false) return { thinkingBudget: 0 };
  if (thinking?.enabled !== true) return undefined;
  const desired = thinking.budgetTokens
    ?? (thinking.effort ? EFFORT_BUDGET_TOKENS[thinking.effort] : DEFAULT_THINKING_BUDGET_TOKENS);
  return {
    includeThoughts: true,
    thinkingBudget: maxOutputTokens === undefined
      ? desired
      : Math.min(desired, maxOutputTokens - 1),
  };
}

export function createGeminiProtocol(
  connection: LLMConnection,
  modelId: string,
): (request: LLMRequest) => AsyncIterable<LLMStreamEvent> {
  const client = createGeminiClient(connection);
  return (request) => streamGemini(client, connection.providerId, modelId, request);
}

export function createGeminiCompletion(
  connection: LLMConnection,
  modelId: string,
): CompleteLLM {
  const client = createGeminiClient(connection);
  return async (request) => {
    try {
      const response = await client.models.generateContent(
        buildGeminiRequest(connection.providerId, modelId, request),
      );
      throwIfAborted(request.signal);
      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason;
      if (!finishReason || String(finishReason) === 'FINISH_REASON_UNSPECIFIED') {
        throw createLLMProviderResponseError({
          protocol: 'gemini-llm',
          message: 'Gemini returned no candidate with a finish reason',
          cause: response,
        });
      }
      const blocks: AssistantBlock[] = [];
      let stopReason = mapStopReason(String(finishReason));
      for (const part of candidate.content?.parts ?? []) {
        if (part.thought && part.text) {
          blocks.push({
            type: 'gemini_thought',
            text: part.text,
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          });
          continue;
        }
        if (part.text) blocks.push({ type: 'text', text: part.text });
        if (part.functionCall) {
          if (!part.functionCall.name) {
            throw new Error('gemini-llm returned a functionCall without name');
          }
          blocks.push({
            type: 'tool_use',
            id: part.functionCall.id ?? `gemini-${randomUUID()}`,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          });
          stopReason = 'tool_use';
        }
      }
      return {
        blocks,
        stopReason,
        usage: createGeminiUsage(response.usageMetadata),
      };
    } catch (error) {
      throwIfAbortError(error, request.signal);
      throw normalizeLLMProviderError(error);
    }
  };
}

function createGeminiClient(connection: LLMConnection): GoogleGenAI {
  const baseUrl = normalizeGeminiBaseUrl(connection.baseUrl);
  return new GoogleGenAI({
    apiKey: connection.apiKey ?? '',
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });
}

function buildGeminiRequest(
  providerId: string,
  modelId: string,
  request: LLMRequest,
): GenerateContentParameters {
  const { system, contents } = toGeminiContents(request.messages, providerId, modelId);
  const config: GenerateContentConfig = {
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    abortSignal: request.signal,
  };
  if (system) config.systemInstruction = system;
  if (request.tools?.length && request.toolChoice !== 'none') {
    config.tools = [{
      functionDeclarations: request.tools.map(toGeminiFunctionDeclaration),
    }];
    config.toolConfig = toGeminiToolConfig(request.toolChoice);
  }
  const thinkingConfig = buildGeminiThinkingConfig(request.thinking, request.maxOutputTokens);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;
  return { model: modelId, contents, config };
}

async function* streamGemini(
  client: GoogleGenAI,
  providerId: string,
  modelId: string,
  request: LLMRequest,
): AsyncIterable<LLMStreamEvent> {
  let stream: AsyncGenerator<GenerateContentResponse>;
  try {
    stream = await client.models.generateContentStream(buildGeminiRequest(providerId, modelId, request));
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLLMProviderError(error);
  }

  let stopReason: LLMStopReason = 'end_turn';
  let receivedFinishReason = false;
  let nextBlockIndex = 0;
  let thinkingBlockIndex: number | undefined;
  let thinkingCompleted = false;
  const thinkingSignatures = new Map<number, string>();
  let textBlockIndex: number | undefined;
  let lastUsage: Extract<LLMStreamEvent, { type: 'usage' }> | undefined;

  try {
    for await (const chunk of stream) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought && part.text) {
          thinkingBlockIndex ??= nextBlockIndex++;
          const thoughtSignature = typeof part.thoughtSignature === 'string'
            ? part.thoughtSignature
            : undefined;
          if (thoughtSignature) {
            thinkingSignatures.set(thinkingBlockIndex, thoughtSignature);
          }
          yield {
            type: 'thinking_delta',
            blockIndex: thinkingBlockIndex,
            delta: part.text,
          };
          continue;
        }
        if (part.text) {
          textBlockIndex ??= nextBlockIndex++;
          yield { type: 'text_delta', blockIndex: textBlockIndex, delta: part.text };
        }
        if (part.functionCall) {
          if (!part.functionCall.name) {
            throw new Error('gemini-llm returned a functionCall without name');
          }
          yield {
            type: 'tool_use_complete',
            blockIndex: nextBlockIndex++,
            callId: `gemini-${randomUUID()}`,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          };
          stopReason = 'tool_use';
        }
      }

      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason && String(finishReason) !== 'FINISH_REASON_UNSPECIFIED') {
        receivedFinishReason = true;
        if (stopReason === 'end_turn') stopReason = mapStopReason(String(finishReason));
      }
      if (chunk.usageMetadata) {
        lastUsage = {
          type: 'usage',
          ...createGeminiUsage(chunk.usageMetadata),
        };
      }
    }
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLLMProviderError(error);
  }

  throwIfAborted(request.signal);
  // 当前读取的 Gemini 响应没有逐块结束事件, 迭代结束后交付思考块的最终状态.
  if (thinkingBlockIndex !== undefined && !thinkingCompleted) {
    thinkingCompleted = true;
    const thoughtSignature = thinkingSignatures.get(thinkingBlockIndex);
    yield {
      type: 'thinking_complete',
      blockIndex: thinkingBlockIndex,
      ...(thoughtSignature
        ? { state: { kind: 'gemini' as const, thoughtSignature } }
        : {}),
    };
  }
  if (!receivedFinishReason) throw new LLMStreamProtocolError('gemini-llm');
  if (lastUsage) yield lastUsage;
  yield { type: 'done', stopReason };
}

function createGeminiUsage(usage: GenerateContentResponse['usageMetadata']) {
  return createLLMTokenUsage({
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cacheReadInputTokens: usage?.cachedContentTokenCount,
  });
}

function toGeminiContents(
  messages: readonly Message[],
  providerId: string,
  modelId: string,
): { system: string | undefined; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];
  const toolNames = new Map<string, string>();
  const toolImages: Part[] = [];
  const flushToolImages = (): void => {
    if (toolImages.length === 0) return;
    appendGeminiUser(contents, [...toolImages]);
    toolImages.length = 0;
  };

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
    }
  }

  for (const message of messages) {
    if (message.role === 'system') {
      system = system ? `${system}\n\n${message.content}` : message.content;
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        flushToolImages();
        appendGeminiUser(contents, [{ text: message.content }]);
        continue;
      }
      const parts: Part[] = [];
      for (const block of message.content as readonly UserBlock[]) {
        if (block.type === 'tool_result') {
          const toolResult = block as ToolResultBlock;
          parts.push({
            functionResponse: {
              name: toolNames.get(toolResult.toolCallId) ?? toolResult.toolCallId,
              response: toGeminiToolResponse(toolResult),
            },
          });
          if (typeof toolResult.content !== 'string') {
            const images = toolResult.content.filter(part => part.type !== 'text');
            if (images.length > 0) {
              toolImages.push({ text: `[工具 ${toolResult.toolCallId} 返回的图片]` });
              toolImages.push(...images.map(toGeminiPart));
            }
          }
        } else {
          if (parts.length > 0) {
            appendGeminiUser(contents, [...parts]);
            parts.length = 0;
          }
          flushToolImages();
          parts.push(toGeminiPart(block as ContentPart));
        }
      }
      if (parts.length > 0) appendGeminiUser(contents, parts);
      continue;
    }

    flushToolImages();
    const parts: Part[] = [];
    // 签名只回传给原生成目标, 正文和工具调用不受此检查影响.
    const replayThought = shouldReplayGeminiThought(message.generatedBy, providerId, modelId);
    for (const block of message.content as readonly AssistantBlock[]) {
      if (block.type === 'text') parts.push({ text: block.text });
      if (block.type === 'tool_use') {
        parts.push({
          functionCall: {
            name: block.name,
            args: block.args as Record<string, unknown>,
          },
        });
      }
      if (block.type === 'gemini_thought' && replayThought) {
        parts.push({
          text: block.text,
          thought: true,
          ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
        } as Part);
      }
    }
    if (parts.length > 0) contents.push({ role: 'model', parts });
  }
  // functionResponse 的 JSON 不是媒体输入. 整批回复后追加图片块, 保留其工具来源.
  flushToolImages();
  return { system, contents };
}

function appendGeminiUser(contents: Content[], parts: Part[]): void {
  const previous = contents.at(-1);
  if (previous?.role !== 'user') {
    contents.push({ role: 'user', parts });
    return;
  }
  contents[contents.length - 1] = {
    role: 'user',
    parts: [...(previous.parts ?? []), ...parts],
  };
}

function toGeminiPart(part: ContentPart): Part {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image_data':
    case 'audio_data':
    case 'file_data':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
    case 'image_url':
      return { fileData: { mimeType: mimeFromUri(part.url), fileUri: part.url } };
    case 'file_url':
      return { fileData: { mimeType: part.mimeType, fileUri: part.url } };
  }
}

function toGeminiToolResponse(toolResult: ToolResultBlock): Record<string, unknown> {
  if (typeof toolResult.content !== 'string') {
    return { content: toolResult.content.filter(part => part.type === 'text') };
  }
  try {
    const parsed = JSON.parse(toolResult.content);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : { content: parsed };
  } catch {
    return { content: toolResult.content };
  }
}

function toGeminiFunctionDeclaration(tool: LLMTool): FunctionDeclaration {
  const { $schema, ...inputSchema } = tool.inputSchema;
  void $schema;
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: inputSchema,
  };
}

function toGeminiToolConfig(choice: LLMRequest['toolChoice']): ToolConfig {
  if (choice === undefined || choice === 'auto') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  }
  if (choice === 'none') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  }
  return {
    functionCallingConfig: {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: [choice.name],
    },
  };
}

function normalizeGeminiBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const clean = baseUrl.replace(/\/+$/, '');
  if (clean.endsWith('/openai') || clean.includes('/openai/')) {
    throw new Error('gemini-llm requires a native Gemini base URL, not an OpenAI-compatible URL');
  }
  return clean.replace(/\/v1(beta|alpha)?$/, '');
}

function mimeFromUri(uri: string): string {
  let path = uri;
  try {
    path = new URL(uri).pathname;
  } catch {
    // 地址无法解析时按原字符串检查扩展名, 不在这里下载或读取文件.
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function mapStopReason(reason: string): LLMStopReason {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'STOP') return 'end_turn';
  return 'stop_sequence';
}
