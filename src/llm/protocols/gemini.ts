// 把中立请求转换为 Gemini generateContent，并归一化 Part 与停止原因。
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
} from '@google/genai';
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponse,
  Part,
  ThinkingConfig,
  ToolConfig,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import {
  LlmStreamProtocolError,
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
  LlmThinking,
  LlmThinkingEffort,
  LlmTool,
  Message,
  UserBlock,
} from '../types.js';
import { createLlmTokenUsage } from '../usage.js';

/** 只重放同一调用目标生成的 thought：thoughtSignature 模型私有，无来源/跨协议/跨 Provider/跨模型都删除。 */
function shouldReplayGeminiThought(
  generatedBy: LlmGenerationSource | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return generatedBy?.protocol === 'gemini-llm'
    && generatedBy.providerId === providerId
    && generatedBy.modelId === modelId;
}

const DEFAULT_THINKING_BUDGET_TOKENS = 8_000;
/** 中立强度档 → thinkingBudget 的产品取值（非官方对照；Google 只给每模型范围）。 */
const EFFORT_BUDGET_TOKENS: Record<LlmThinkingEffort, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  max: 32_000,
};

/**
 * 构造 Gemini thinkingConfig：enabled=false 显式关闭（thinkingBudget 0）；
 * enabled=true 时 budgetTokens 显式值 > effort 映射表 > 默认 8K，
 * 预算 clamp 到 maxOutputTokens - 1（thinking 计入输出）。
 */
export function buildGeminiThinkingConfig(
  thinking: LlmThinking | undefined,
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
  connection: LlmConnection, modelId: string,
): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  const baseUrl = normalizeGeminiBaseUrl(connection.baseUrl);
  const client = new GoogleGenAI({
    apiKey: connection.apiKey ?? '',
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });
  return (request) => streamGemini(client, connection.providerId, modelId, request);
}

async function* streamGemini(
  client: GoogleGenAI,
  providerId: string,
  modelId: string,
  request: LlmRequest,
): AsyncIterable<LlmStreamEvent> {
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

  let stream: AsyncGenerator<GenerateContentResponse>;
  try {
    stream = await client.models.generateContentStream({
      model: modelId,
      contents,
      config,
    });
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLlmProviderError(error);
  }

  let stopReason: LlmStopReason = 'end_turn';
  let receivedFinishReason = false;
  let nextBlockIndex = 0;
  let thinkingBlockIndex: number | undefined;
  let thinkingCompleted = false;
  const thinkingSignatures = new Map<number, string>();
  let textBlockIndex: number | undefined;
  let lastUsage: Extract<LlmStreamEvent, { type: 'usage' }> | undefined;

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
          ...createLlmTokenUsage({
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            cacheReadInputTokens: chunk.usageMetadata.cachedContentTokenCount,
          }),
        };
      }
    }
  } catch (error) {
    throwIfAbortError(error, request.signal);
    throw normalizeLlmProviderError(error);
  }

  throwIfAborted(request.signal);
  // Gemini 没有 per-block 完成事件：流收口时统一发一次 thinking_complete（带 thoughtSignature）。
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
  if (!receivedFinishReason) throw new LlmStreamProtocolError('gemini-llm');
  if (lastUsage) yield lastUsage;
  yield { type: 'done', stopReason };
}

function toGeminiContents(
  messages: readonly Message[],
  providerId: string,
  modelId: string,
): { system: string | undefined; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];
  const toolNames = new Map<string, string>();

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
        contents.push({ role: 'user', parts: [{ text: message.content }] });
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
        } else {
          parts.push(toGeminiPart(block as ContentPart));
        }
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
      continue;
    }

    const parts: Part[] = [];
    // thought 只随生成它的同一个调用目标重放（thoughtSignature 模型私有）；
    // 无来源、跨协议/跨 Provider/跨模型的 thought 一律删除，text/tool_use 不受影响。
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
  return { system, contents };
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
  if (typeof toolResult.content !== 'string') return { content: toolResult.content };
  try {
    const parsed = JSON.parse(toolResult.content);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : { content: parsed };
  } catch {
    return { content: toolResult.content };
  }
}

function toGeminiFunctionDeclaration(tool: LlmTool): FunctionDeclaration {
  const { $schema, ...inputSchema } = tool.inputSchema;
  void $schema;
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: inputSchema,
  };
}

function toGeminiToolConfig(choice: LlmRequest['toolChoice']): ToolConfig {
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
    // gs:// URI 不能被所有 Node URL 版本一致解析，直接检查原字符串即可。
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function mapStopReason(reason: string): LlmStopReason {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'STOP') return 'end_turn';
  return 'stop_sequence';
}
