/**
 * OpenAI-compatible 适配器。
 *
 * 05-06 目标：覆盖 DeepSeek / OpenRouter / Ollama 这类兼容 `/chat/completions`
 * 的 provider。它们共享 OpenAI Chat Completions 的 wire protocol，但认证、baseUrl、
 * 模型目录和附加 header 不同，所以这里做成一个可配置通用类，并提供三个内置子类。
 */

import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ModelDescriptor,
  ToolSpec,
} from "@ema-agent/core-types";
import {
  DEEPSEEK_COMPATIBLE_MODELS,
  OLLAMA_COMPATIBLE_MODELS,
  OPENROUTER_COMPATIBLE_MODELS,
} from "../catalog.js";
import { LlmProviderError, missingApiKeyError } from "../errors.js";
import { joinUrl, normalizeBaseUrl, postJson, readJson, requestJson } from "../http.js";
import type { LlmProvider } from "../provider.js";
import { parseSseJsonData, readSseMessages } from "../sse.js";
import type { NativeProviderConfig, ProviderRuntimeIntrospection, RuntimeFetch } from "../types.js";
import { mergeUsage, normalizeOpenAICompatibleUsage } from "../usage.js";

export interface OpenAICompatibleProviderConfig extends NativeProviderConfig {
  /** Provider ID，例如 deepseek / openrouter / ollama。 */
  providerId: string;
  /** 设置页展示名称。 */
  displayName: string;
  /** 官网链接。 */
  website?: string;
  /** 图标 key。 */
  icon?: string;
  /** API key 环境变量名。 */
  apiKeyEnvName?: string;
  /** 是否强制要求 API key；Ollama 本地默认不需要。 */
  requireApiKey?: boolean;
  /** 静态模型目录，远端刷新会在 05-07 catalog/config 继续完善。 */
  models?: readonly ModelDescriptor[];
  /** Chat Completions 路径，少数网关可覆盖。 */
  chatCompletionsPath?: string;
  /** Models 路径。 */
  listModelsPath?: string;
  /** 是否给 streaming 请求发送 stream_options.include_usage。兼容层默认保守关闭。 */
  includeUsageInStream?: boolean;
  /** 附加请求体，例如 OpenRouter 的 provider routing 可放这里。 */
  defaultBody?: Record<string, unknown>;
}

export interface OpenRouterCompatibleProviderConfig extends NativeProviderConfig {
  models?: readonly ModelDescriptor[];
  appReferer?: string;
  appTitle?: string;
  includeUsageInStream?: boolean;
  defaultBody?: Record<string, unknown>;
}

export type DeepSeekCompatibleProviderConfig = NativeProviderConfig & {
  models?: readonly ModelDescriptor[];
  includeUsageInStream?: boolean;
  defaultBody?: Record<string, unknown>;
};

export type OllamaCompatibleProviderConfig = NativeProviderConfig & {
  models?: readonly ModelDescriptor[];
  includeUsageInStream?: boolean;
  defaultBody?: Record<string, unknown>;
};

interface OpenAICompatibleToolState {
  id: string;
  toolName: string;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown[];
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  error?: unknown;
}

/** 通用 OpenAI Chat Completions 兼容 Provider。 */
export class OpenAICompatibleProvider implements LlmProvider, ProviderRuntimeIntrospection {
  readonly id: string;
  readonly displayName: string;
  readonly website?: string;
  readonly icon?: string;
  readonly models: readonly ModelDescriptor[];

  private readonly apiKey: string;
  private readonly apiKeyEnvName?: string;
  private readonly requireApiKey: boolean;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl?: RuntimeFetch;
  private readonly chatCompletionsPath: string;
  private readonly listModelsPath: string;
  private readonly includeUsageInStream: boolean;
  private readonly defaultBody: Record<string, unknown>;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.website = config.website;
    this.icon = config.icon;
    this.models = config.models ?? [];
    this.apiKeyEnvName = config.apiKeyEnvName;
    this.apiKey = config.apiKey ?? (config.apiKeyEnvName ? process.env[config.apiKeyEnvName] : undefined) ?? "";
    this.requireApiKey = config.requireApiKey ?? true;
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "http://localhost:11434/v1");
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetch;
    this.chatCompletionsPath = config.chatCompletionsPath ?? "/chat/completions";
    this.listModelsPath = config.listModelsPath ?? "/models";
    this.includeUsageInStream = config.includeUsageInStream ?? false;
    this.defaultBody = config.defaultBody ?? {};
  }

  /** 非流式 Chat Completions 调用。 */
  async chat(request: ChatCompletionRequest): Promise<string> {
    const response = await this.createChatCompletion(request, false);
    const payload = await readJson<ChatCompletionsResponse>(this.id, response, request.requestId);
    this.assertNotError(payload, request.requestId);
    return extractOpenAICompatibleText(payload);
  }

  /** 流式 Chat Completions 调用，兼容 OpenAI/DeepSeek/OpenRouter/Ollama SSE chunk。 */
  async *chatStream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const response = await this.createChatCompletion(request, true);
    const toolStates = new Map<number, OpenAICompatibleToolState>();
    let finalUsage: ChatCompletionChunk["usage"] | undefined;
    let finalReason: ChatCompletionChunk["finishReason"] = null;
    let sawFinalChunk = false;

    for await (const message of readSseMessages(response.body)) {
      const event = asRecord(parseSseJsonData(message.data));
      if (!event) {
        continue;
      }
      if (event.error) {
        throw buildOpenAICompatibleStreamError(this.id, event, request.requestId);
      }

      finalUsage = mergeUsage(finalUsage, normalizeOpenAICompatibleUsage(event.usage));
      const choices = readArray(event.choices);
      for (const choice of choices) {
        const choiceRecord = asRecord(choice);
        const index = readNumber(choiceRecord, "index") ?? 0;
        const delta = asRecord(choiceRecord?.delta);
        const content = readString(delta, "content");
        if (content) {
          yield {
            index,
            delta: { content },
            token: content,
          };
        }

        for (const toolCallDelta of readArray(delta?.tool_calls)) {
          const chunk = mapToolCallDelta(toolStates, toolCallDelta, request, index);
          if (chunk) {
            yield chunk;
          }
        }

        const finishReason = readString(choiceRecord, "finish_reason");
        if (finishReason) {
          finalReason = mapOpenAICompatibleFinishReason(finishReason);
          yield {
            index,
            delta: {},
            usage: finalUsage,
            finishReason: finalReason,
          };
          sawFinalChunk = true;
        }
      }
    }

    if (!sawFinalChunk) {
      yield {
        index: 0,
        delta: {},
        usage: finalUsage,
        finishReason: finalReason,
      };
    }
  }

  /** 轻量健康检查：调用 /models，兼容远端和本地 Ollama。 */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();
    const models = await this.listRemoteModels();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: `${models.length} models returned.`,
    };
  }

  /** OpenAI-compatible Models API。 */
  async listRemoteModels(): Promise<readonly string[]> {
    this.ensureApiKeyIfNeeded();
    const response = await requestJson({
      providerId: this.id,
      url: joinUrl(this.baseUrl, this.listModelsPath),
      method: "GET",
      headers: this.buildHeaders("application/json"),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    const payload = await readJson<{ data?: Array<{ id?: string }> }>(this.id, response);
    return payload.data?.map(model => model.id).filter((id): id is string => typeof id === "string") ?? [];
  }

  private async createChatCompletion(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    this.ensureApiKeyIfNeeded();
    return postJson({
      providerId: this.id,
      url: joinUrl(this.baseUrl, this.chatCompletionsPath),
      headers: this.buildHeaders(stream ? "text/event-stream" : "application/json"),
      body: buildChatCompletionsPayload(request, stream, this.includeUsageInStream, this.defaultBody),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      requestId: request.requestId,
    });
  }

  private ensureApiKeyIfNeeded(): void {
    if (this.requireApiKey && !this.apiKey) {
      throw missingApiKeyError(this.id, this.apiKeyEnvName ?? `${this.id.toUpperCase()}_API_KEY`);
    }
  }

  private buildHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      "content-type": "application/json",
      "accept": accept,
    };

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private assertNotError(payload: ChatCompletionsResponse, requestId?: string): void {
    if (payload.error) {
      throw buildOpenAICompatibleStreamError(this.id, { error: payload.error }, requestId);
    }
  }
}

/** DeepSeek 官方 OpenAI-compatible Provider。 */
export class DeepSeekCompatibleProvider extends OpenAICompatibleProvider {
  constructor(config: DeepSeekCompatibleProviderConfig = {}) {
    super({
      providerId: "deepseek",
      displayName: "DeepSeek",
      website: "https://www.deepseek.com",
      icon: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnvName: "DEEPSEEK_API_KEY",
      models: DEEPSEEK_COMPATIBLE_MODELS,
      requireApiKey: true,
      includeUsageInStream: true,
      ...config,
    });
  }
}

/** OpenRouter 官方 OpenAI-compatible Provider。 */
export class OpenRouterCompatibleProvider extends OpenAICompatibleProvider {
  constructor(config: OpenRouterCompatibleProviderConfig = {}) {
    const defaultHeaders = {
      ...(config.defaultHeaders ?? {}),
      ...(config.appReferer ? { "HTTP-Referer": config.appReferer } : {}),
      ...(config.appTitle ? { "X-Title": config.appTitle } : {}),
    };

    super({
      providerId: "openrouter",
      displayName: "OpenRouter",
      website: "https://openrouter.ai",
      icon: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnvName: "OPENROUTER_API_KEY",
      models: OPENROUTER_COMPATIBLE_MODELS,
      requireApiKey: true,
      includeUsageInStream: true,
      ...config,
      defaultHeaders,
    });
  }
}

/** Ollama 本地 OpenAI-compatible Provider。 */
export class OllamaCompatibleProvider extends OpenAICompatibleProvider {
  constructor(config: OllamaCompatibleProviderConfig = {}) {
    super({
      providerId: "ollama",
      displayName: "Ollama",
      website: "https://ollama.com",
      icon: "ollama",
      baseUrl: "http://localhost:11434/v1",
      apiKeyEnvName: "OLLAMA_API_KEY",
      models: OLLAMA_COMPATIBLE_MODELS,
      requireApiKey: false,
      includeUsageInStream: false,
      ...config,
    });
  }
}

function buildChatCompletionsPayload(
  request: ChatCompletionRequest,
  stream: boolean,
  includeUsageInStream: boolean,
  defaultBody: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...defaultBody,
    model: request.modelId,
    messages: request.messages.map(mapChatCompletionsMessage),
    stream,
  };

  if (request.temperature !== undefined) {
    payload.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    payload.max_tokens = request.maxTokens;
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map(mapChatCompletionsTool);
  }
  if (stream && includeUsageInStream) {
    payload.stream_options = {
      include_usage: true,
    };
  }

  return payload;
}

function mapChatCompletionsMessage(message: ChatCompletionMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: "function",
        function: {
          name: call.toolName,
          arguments: call.argumentsDelta,
        },
      })),
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "unknown_tool_call",
      content: message.content,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function mapChatCompletionsTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function extractOpenAICompatibleText(payload: ChatCompletionsResponse): string {
  const parts: string[] = [];
  for (const choice of payload.choices ?? []) {
    const content = choice.message?.content;
    if (typeof content === "string") {
      parts.push(content);
    }
  }
  return parts.join("");
}

function mapToolCallDelta(
  toolStates: Map<number, OpenAICompatibleToolState>,
  toolCallDelta: unknown,
  request: ChatCompletionRequest,
  choiceIndex: number,
): ChatCompletionChunk | undefined {
  const record = asRecord(toolCallDelta);
  const callIndex = readNumber(record, "index") ?? 0;
  const functionDelta = asRecord(record?.function);
  const id = readString(record, "id");
  const name = readString(functionDelta, "name");
  const argumentsDelta = readString(functionDelta, "arguments") ?? "";

  const previous = toolStates.get(callIndex);
  const next: OpenAICompatibleToolState = {
    id: id ?? previous?.id ?? buildCompatibleToolCallId(request, choiceIndex, callIndex),
    toolName: name ?? previous?.toolName ?? "unknown_tool",
  };
  toolStates.set(callIndex, next);

  if (!id && !name && !argumentsDelta) {
    return undefined;
  }

  return {
    index: choiceIndex,
    delta: {},
    toolCalls: [
      {
        id: next.id,
        toolName: next.toolName,
        argumentsDelta,
      },
    ],
  };
}

function mapOpenAICompatibleFinishReason(reason: string): ChatCompletionChunk["finishReason"] {
  if (reason === "stop") {
    return "stop";
  }
  if (reason === "length") {
    return "length";
  }
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_calls";
  }
  if (reason === "content_filter") {
    return "content_filter";
  }
  return null;
}

function buildOpenAICompatibleStreamError(providerId: string, event: Record<string, unknown>, requestId?: string): LlmProviderError {
  const error = asRecord(event.error);
  const message = readString(error, "message") ?? `${providerId} chat completion failed.`;
  const providerCode = readString(error, "code") ?? readString(error, "type");
  return new LlmProviderError(message, {
    providerId,
    code: providerCode === "rate_limit_exceeded" ? "rate_limited" : "provider_internal",
    requestId,
    providerCode,
    retryable: providerCode === "rate_limit_exceeded",
    details: event,
  });
}

function buildCompatibleToolCallId(request: ChatCompletionRequest, choiceIndex: number, callIndex: number): string {
  const stablePrefix = request.requestId ?? request.traceId ?? request.sessionId;
  return `compat-${stablePrefix}-${choiceIndex}-${callIndex}`;
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

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
