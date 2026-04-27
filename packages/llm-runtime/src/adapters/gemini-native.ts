/**
 * Gemini 原生适配器。
 *
 * 05-05 目标：直接接 Google Gemini GenerateContent API，而不是走 OpenAI 兼容层。
 * - 非流式：models/{model}:generateContent
 * - 流式：models/{model}:streamGenerateContent?alt=sse
 * - 工具：把 ToolSpec 映射为 functionDeclarations
 *
 * 注意：Gemini 的 function call 没有 OpenAI/Anthropic 那种稳定 call id。
 * 这里生成本地 call id，保证上层 tool-runtime 能按统一协议继续流转。
 */

import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ModelDescriptor,
  ToolCallChunk,
  ToolSpec,
} from "@ema-agent/core-types";
import { GEMINI_NATIVE_MODELS } from "../catalog.js";
import { LlmProviderError, missingApiKeyError } from "../errors.js";
import { joinUrl, normalizeBaseUrl, postJson, readJson, requestJson } from "../http.js";
import type { LlmProvider } from "../provider.js";
import { parseSseJsonData, readSseMessages } from "../sse.js";
import type { NativeProviderConfig, ProviderRuntimeIntrospection, RuntimeFetch } from "../types.js";
import { mergeUsage, normalizeGeminiUsage } from "../usage.js";

export interface GeminiNativeProviderConfig extends NativeProviderConfig {
  /** Google API key 的备用环境变量名；默认同时读 GEMINI_API_KEY / GOOGLE_API_KEY。 */
  apiKeyEnvName?: string;
}

type GeminiRole = "user" | "model";

interface GeminiPart {
  text?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role?: GeminiRole;
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: unknown;
  promptFeedback?: unknown;
}

/** Google Gemini 原生 GenerateContent Provider。 */
export class GeminiNativeProvider implements LlmProvider, ProviderRuntimeIntrospection {
  readonly id = "gemini";
  readonly displayName = "Google Gemini";
  readonly website = "https://ai.google.dev";
  readonly icon = "gemini";
  readonly models: readonly ModelDescriptor[] = GEMINI_NATIVE_MODELS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl?: RuntimeFetch;
  private readonly apiKeyEnvName: string;

  constructor(config: GeminiNativeProviderConfig = {}) {
    this.apiKeyEnvName = config.apiKeyEnvName ?? "GEMINI_API_KEY";
    this.apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta");
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetch;
  }

  /** 非流式 GenerateContent 调用，主要给标题、summary、小任务使用。 */
  async chat(request: ChatCompletionRequest): Promise<string> {
    const response = await this.generateContent(request, false);
    const payload = await readJson<GeminiGenerateContentResponse>(this.id, response, request.requestId);
    this.assertNotBlocked(payload, request.requestId);
    return extractGeminiText(payload);
  }

  /** 流式 GenerateContent 调用，归一化 text/functionCall/usage。 */
  async *chatStream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const response = await this.generateContent(request, true);
    let finalUsage: ChatCompletionChunk["usage"] | undefined;
    let finalReason: ChatCompletionChunk["finishReason"] = null;
    let sawToolCall = false;
    let finalSent = false;

    for await (const message of readSseMessages(response.body)) {
      const event = asRecord(parseSseJsonData(message.data));
      if (!event) {
        continue;
      }

      finalUsage = mergeUsage(finalUsage, normalizeGeminiUsage(event.usageMetadata));
      const candidates = readArray(event.candidates);
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const candidateRecord = asRecord(candidate);
        const finishReason = readString(candidateRecord, "finishReason");
        if (finishReason) {
          finalReason = mapGeminiFinishReason(finishReason);
        }

        const content = asRecord(candidateRecord?.content);
        const parts = readArray(content?.parts);
        for (const [partIndex, part] of parts.entries()) {
          const partRecord = asRecord(part);
          const text = readString(partRecord, "text");
          if (text) {
            yield {
              index: candidateIndex,
              delta: { content: text },
              token: text,
            };
          }

          const functionCall = asRecord(partRecord?.functionCall);
          const functionName = readString(functionCall, "name");
          if (functionName) {
            sawToolCall = true;
            yield {
              index: candidateIndex,
              delta: {},
              toolCalls: [
                {
                  id: buildGeminiToolCallId(request, candidateIndex, partIndex, functionName),
                  toolName: functionName,
                  argumentsDelta: JSON.stringify(asRecord(functionCall?.args) ?? {}),
                },
              ],
            };
          }
        }
      }
    }

    if (!finalSent) {
      yield {
        index: 0,
        delta: {},
        usage: finalUsage,
        finishReason: sawToolCall ? "tool_calls" : finalReason,
      };
      finalSent = true;
    }
  }

  /** 轻量健康检查：调用 /models，验证 API key、网络和 endpoint。 */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();
    const models = await this.listRemoteModels();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: `${models.length} models returned.`,
    };
  }

  /** Gemini ListModels API，设置页刷新模型目录时使用。 */
  async listRemoteModels(): Promise<readonly string[]> {
    this.ensureApiKey();
    const response = await requestJson({
      providerId: this.id,
      url: joinUrl(this.baseUrl, "/models"),
      method: "GET",
      headers: this.buildHeaders("application/json"),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    const payload = await readJson<{ models?: Array<{ name?: string }> }>(this.id, response);
    return payload.models
      ?.map(model => model.name?.replace(/^models\//u, ""))
      .filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];
  }

  private async generateContent(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    this.ensureApiKey();
    const modelId = normalizeGeminiModelId(request.modelId);
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";

    return postJson({
      providerId: this.id,
      url: joinUrl(this.baseUrl, `/models/${encodeURIComponent(modelId)}:${method}`),
      headers: this.buildHeaders(stream ? "text/event-stream" : "application/json"),
      body: buildGeminiPayload(request),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      requestId: request.requestId,
    });
  }

  private ensureApiKey(): void {
    if (!this.apiKey) {
      throw missingApiKeyError(this.id, `${this.apiKeyEnvName} or GOOGLE_API_KEY`);
    }
  }

  private buildHeaders(accept: string): Record<string, string> {
    return {
      ...this.defaultHeaders,
      "x-goog-api-key": this.apiKey,
      "content-type": "application/json",
      "accept": accept,
    };
  }

  private assertNotBlocked(payload: GeminiGenerateContentResponse, requestId?: string): void {
    const feedback = asRecord(payload.promptFeedback);
    const blockReason = readString(feedback, "blockReason");
    if (blockReason) {
      throw new LlmProviderError(`Gemini prompt blocked: ${blockReason}.`, {
        providerId: this.id,
        code: "safety_blocked",
        requestId,
        retryable: false,
        details: payload.promptFeedback,
      });
    }
  }
}

function buildGeminiPayload(request: ChatCompletionRequest): Record<string, unknown> {
  const mapped = mapGeminiMessages(request.messages);
  const payload: Record<string, unknown> = {
    contents: mapped.contents,
  };

  if (mapped.systemInstruction) {
    payload.systemInstruction = mapped.systemInstruction;
  }
  if (request.temperature !== undefined || request.maxTokens !== undefined) {
    payload.generationConfig = {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    };
  }
  if (request.tools?.length) {
    payload.tools = [
      {
        functionDeclarations: request.tools.map(mapGeminiTool),
      },
    ];
  }

  return payload;
}

function mapGeminiMessages(messages: readonly ChatCompletionMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
} {
  const systemParts: Array<{ text: string }> = [];
  const contents: GeminiContent[] = [];
  const toolNamesByCallId = new Map<string, string>();

  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      toolNamesByCallId.set(call.id, call.toolName);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) {
        systemParts.push({ text: message.content });
      }
      continue;
    }

    const content = mapGeminiContent(message, toolNamesByCallId);
    if (!content || content.parts.length === 0) {
      continue;
    }

    const previous = contents.length > 0 ? contents[contents.length - 1] : undefined;
    if (previous !== undefined && previous.role === content.role) {
      previous.parts.push(...content.parts);
    } else {
      contents.push(content);
    }
  }

  return {
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    contents,
  };
}

function mapGeminiContent(message: ChatCompletionMessage, toolNamesByCallId: ReadonlyMap<string, string>): GeminiContent | undefined {
  if (message.role === "tool") {
    const name = message.toolCallId ? toolNamesByCallId.get(message.toolCallId) ?? message.toolCallId : "tool_result";
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name,
            response: { result: message.content },
          },
        },
      ],
    };
  }

  const parts: GeminiPart[] = [];
  if (message.content.trim()) {
    parts.push({ text: message.content });
  }

  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      parts.push(mapGeminiFunctionCall(call));
    }
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts,
  };
}

function mapGeminiFunctionCall(call: ToolCallChunk): GeminiPart {
  return {
    functionCall: {
      name: call.toolName,
      args: parseToolArguments(call.argumentsDelta),
    },
  };
}

function mapGeminiTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function extractGeminiText(payload: GeminiGenerateContentResponse): string {
  const parts: string[] = [];
  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

function mapGeminiFinishReason(reason: string): ChatCompletionChunk["finishReason"] {
  if (reason === "MAX_TOKENS") {
    return "length";
  }
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "PROHIBITED_CONTENT" || reason === "SPII") {
    return "content_filter";
  }
  if (reason === "STOP") {
    return "stop";
  }
  return null;
}

function buildGeminiToolCallId(request: ChatCompletionRequest, candidateIndex: number, partIndex: number, functionName: string): string {
  const stablePrefix = request.requestId ?? request.traceId ?? request.sessionId;
  return `gemini-${stablePrefix}-${candidateIndex}-${partIndex}-${functionName}`;
}

function normalizeGeminiModelId(modelId: string): string {
  return modelId.replace(/^models\//u, "");
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
