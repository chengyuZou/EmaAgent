/**
 * Anthropic 原生适配器。
 *
 * 05-04 目标：直接接 Anthropic Messages API。
 * - system prompt 放顶层 system。
 * - user/assistant/tool 历史转换成 Anthropic content block。
 * - 流式事件按 message_start/content_block_delta/message_delta/message_stop 归一化。
 */

import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ModelDescriptor,
  ToolCallChunk,
  ToolSpec,
} from "@ema-agent/core-types";
import { ANTHROPIC_NATIVE_MODELS } from "../catalog.js";
import { LlmProviderError, missingApiKeyError } from "../errors.js";
import { joinUrl, normalizeBaseUrl, postJson, readJson, requestJson } from "../http.js";
import type { LlmProvider } from "../provider.js";
import { parseSseJsonData, readSseMessages } from "../sse.js";
import type { NativeProviderConfig, ProviderRuntimeIntrospection, RuntimeFetch } from "../types.js";
import { mergeUsage, normalizeAnthropicUsage } from "../usage.js";

export interface AnthropicNativeProviderConfig extends NativeProviderConfig {
  /** Anthropic API version header；默认使用稳定 Messages API 版本。 */
  anthropicVersion?: string;
  /** Anthropic beta header，多个 beta 用逗号拼接。 */
  beta?: string | readonly string[];
}

type AnthropicRole = "user" | "assistant";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: AnthropicRole;
  content: AnthropicContentBlock[];
}

interface AnthropicPayloadMessages {
  system?: string;
  messages: AnthropicMessage[];
}

interface AnthropicMessageResponse {
  content?: unknown[];
  usage?: unknown;
  stop_reason?: string;
  error?: unknown;
}

interface AnthropicToolBlockState {
  id: string;
  toolName: string;
}

/** Anthropic 官方 Messages API Provider。 */
export class AnthropicNativeProvider implements LlmProvider, ProviderRuntimeIntrospection {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";
  readonly website = "https://www.anthropic.com";
  readonly icon = "anthropic";
  readonly models: readonly ModelDescriptor[] = ANTHROPIC_NATIVE_MODELS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl?: RuntimeFetch;
  private readonly anthropicVersion: string;
  private readonly beta?: string;

  constructor(config: AnthropicNativeProviderConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://api.anthropic.com/v1");
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetch;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.beta = typeof config.beta === "string" ? config.beta : config.beta?.join(",");
  }

  /** 非流式 Messages API 调用。 */
  async chat(request: ChatCompletionRequest): Promise<string> {
    const response = await this.createMessage(request, false);
    const payload = await readJson<AnthropicMessageResponse>(this.id, response, request.requestId);
    this.assertResponseNotFailed(payload, request.requestId);
    return extractAnthropicText(payload);
  }

  /** 流式 Messages API 调用，直接归一化 text/tool/usage。 */
  async *chatStream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const response = await this.createMessage(request, true);
    const toolBlocks = new Map<number, AnthropicToolBlockState>();
    let finalUsage: ChatCompletionChunk["usage"] | undefined;
    let stopReason: string | undefined;
    let finalSent = false;

    for await (const message of readSseMessages(response.body)) {
      const event = asRecord(parseSseJsonData(message.data));
      if (!event) {
        continue;
      }

      const type = readString(event, "type") ?? message.event;
      if (!type) {
        continue;
      }

      if (type === "message_start") {
        const startedMessage = asRecord(event.message);
        finalUsage = mergeUsage(finalUsage, normalizeAnthropicUsage(startedMessage?.usage));
        continue;
      }

      if (type === "content_block_start") {
        const index = readNumber(event, "index") ?? 0;
        const block = asRecord(event.content_block);
        if (block?.type === "tool_use") {
          const id = readString(block, "id");
          const toolName = readString(block, "name");
          if (id && toolName) {
            toolBlocks.set(index, { id, toolName });
          }
        }

        const initialText = block?.type === "text" ? readString(block, "text") : undefined;
        if (initialText) {
          yield {
            index,
            delta: { content: initialText },
            token: initialText,
          };
        }
        continue;
      }

      if (type === "content_block_delta") {
        const index = readNumber(event, "index") ?? 0;
        const delta = asRecord(event.delta);
        const deltaType = readString(delta, "type");

        if (deltaType === "text_delta") {
          const text = readString(delta, "text");
          if (text) {
            yield {
              index,
              delta: { content: text },
              token: text,
            };
          }
          continue;
        }

        if (deltaType === "input_json_delta") {
          const partialJson = readString(delta, "partial_json") ?? "";
          const toolState = toolBlocks.get(index);
          yield {
            index,
            delta: {},
            toolCalls: [
              {
                id: toolState?.id ?? `tool-${index}`,
                toolName: toolState?.toolName ?? "unknown_tool",
                argumentsDelta: partialJson,
              },
            ],
          };
          continue;
        }
      }

      if (type === "message_delta") {
        const delta = asRecord(event.delta);
        stopReason = readString(delta, "stop_reason") ?? stopReason;
        finalUsage = mergeUsage(finalUsage, normalizeAnthropicUsage(event.usage));
        continue;
      }

      if (type === "message_stop") {
        yield {
          index: 0,
          delta: {},
          usage: finalUsage,
          finishReason: mapAnthropicStopReason(stopReason),
        };
        finalSent = true;
        continue;
      }

      if (type === "error") {
        throw buildAnthropicStreamError(event, request.requestId);
      }
    }

    if (!finalSent) {
      yield {
        index: 0,
        delta: {},
        usage: finalUsage,
        finishReason: mapAnthropicStopReason(stopReason),
      };
    }
  }

  /** 轻量健康检查：调用 /models，设置页可以用它验证 API key 与网络。 */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();
    const models = await this.listRemoteModels();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: `${models.length} models returned.`,
    };
  }

  /** Anthropic Models API，供后续 model catalog 刷新使用。 */
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

    const payload = await readJson<{ data?: Array<{ id?: string }> }>(this.id, response);
    return payload.data?.map(model => model.id).filter((id): id is string => typeof id === "string") ?? [];
  }

  private async createMessage(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    this.ensureApiKey();
    return postJson({
      providerId: this.id,
      url: joinUrl(this.baseUrl, "/messages"),
      headers: this.buildHeaders(stream ? "text/event-stream" : "application/json"),
      body: buildAnthropicMessagePayload(request, stream, this.resolveMaxTokens(request)),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      requestId: request.requestId,
    });
  }

  private resolveMaxTokens(request: ChatCompletionRequest): number {
    const descriptor = this.models.find(model => model.id === request.modelId);
    const requested = request.maxTokens ?? descriptor?.maxOutputTokens ?? 4_096;
    return descriptor ? Math.min(requested, descriptor.maxOutputTokens) : requested;
  }

  private ensureApiKey(): void {
    if (!this.apiKey) {
      throw missingApiKeyError(this.id, "ANTHROPIC_API_KEY");
    }
  }

  private buildHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      "content-type": "application/json",
      "accept": accept,
    };

    if (this.beta) {
      headers["anthropic-beta"] = this.beta;
    }

    return headers;
  }

  private assertResponseNotFailed(payload: AnthropicMessageResponse, requestId?: string): void {
    if (payload.error) {
      throw buildAnthropicStreamError({ type: "error", error: payload.error }, requestId);
    }
  }
}

function buildAnthropicMessagePayload(
  request: ChatCompletionRequest,
  stream: boolean,
  maxTokens: number,
): Record<string, unknown> {
  const mapped = mapAnthropicMessages(request.messages);
  const payload: Record<string, unknown> = {
    model: request.modelId,
    max_tokens: maxTokens,
    messages: mapped.messages,
    stream,
  };

  if (mapped.system) {
    payload.system = mapped.system;
  }
  if (request.temperature !== undefined) {
    payload.temperature = request.temperature;
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map(mapAnthropicTool);
  }

  return payload;
}

function mapAnthropicMessages(messages: readonly ChatCompletionMessage[]): AnthropicPayloadMessages {
  const systemParts: string[] = [];
  const mapped: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) {
        systemParts.push(message.content);
      }
      continue;
    }

    const role: AnthropicRole = message.role === "assistant" ? "assistant" : "user";
    const blocks = mapAnthropicContentBlocks(message);
    if (blocks.length === 0) {
      continue;
    }

    const previous = mapped.at(-1);
    if (previous?.role === role) {
      previous.content.push(...blocks);
    } else {
      mapped.push({ role, content: blocks });
    }
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: mapped,
  };
}

function mapAnthropicContentBlocks(message: ChatCompletionMessage): AnthropicContentBlock[] {
  if (message.role === "tool") {
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "unknown_tool_call",
        content: message.content,
      },
    ];
  }

  const blocks: AnthropicContentBlock[] = [];
  if (message.content.trim()) {
    blocks.push({
      type: "text",
      text: message.content,
    });
  }

  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      blocks.push(mapAnthropicToolUseBlock(call));
    }
  }

  return blocks;
}

function mapAnthropicToolUseBlock(call: ToolCallChunk): AnthropicToolUseBlock {
  return {
    type: "tool_use",
    id: call.id,
    name: call.toolName,
    input: parseToolArguments(call.argumentsDelta),
  };
}

function mapAnthropicTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function extractAnthropicText(payload: AnthropicMessageResponse): string {
  const parts: string[] = [];
  for (const block of payload.content ?? []) {
    const record = asRecord(block);
    if (record?.type === "text") {
      const text = readString(record, "text");
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
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

function mapAnthropicStopReason(stopReason: string | undefined): ChatCompletionChunk["finishReason"] {
  if (stopReason === "max_tokens") {
    return "length";
  }
  if (stopReason === "tool_use") {
    return "tool_calls";
  }
  if (stopReason === "end_turn" || stopReason === "stop_sequence") {
    return "stop";
  }
  return null;
}

function buildAnthropicStreamError(event: Record<string, unknown>, requestId?: string): LlmProviderError {
  const error = asRecord(event.error);
  const message = readString(error, "message") ?? "Anthropic response failed.";
  const providerCode = readString(error, "type");

  return new LlmProviderError(message, {
    providerId: "anthropic",
    code: providerCode === "rate_limit_error" ? "rate_limited" : "provider_internal",
    requestId,
    providerCode,
    retryable: providerCode === "rate_limit_error" || providerCode === "overloaded_error",
    details: event,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
