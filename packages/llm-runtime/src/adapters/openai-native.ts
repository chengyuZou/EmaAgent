/**
 * OpenAI 原生适配器。
 *
 * 05-03 目标：不再使用 mock，而是直接接 OpenAI Responses API。
 * - 非流式：POST /responses，读取 output_text / output[].content[].text。
 * - 流式：解析 typed SSE events，归一化为 ChatCompletionChunk。
 * - 工具：把项目内 ToolSpec 映射为 Responses function tools，并输出函数参数增量。
 */

import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ModelDescriptor,
  ToolSpec,
} from "@ema-agent/core-types";
import { OPENAI_NATIVE_MODELS } from "../catalog.js";
import { LlmProviderError, missingApiKeyError } from "../errors.js";
import { joinUrl, normalizeBaseUrl, postJson, readJson, requestJson } from "../http.js";
import type { LlmProvider } from "../provider.js";
import { parseSseJsonData, readSseMessages } from "../sse.js";
import type { NativeProviderConfig, ProviderRuntimeIntrospection, RuntimeFetch } from "../types.js";
import { normalizeOpenAIUsage } from "../usage.js";

export interface OpenAINativeProviderConfig extends NativeProviderConfig {
  /** OpenAI Organization header，可选。 */
  organization?: string;
  /** OpenAI Project header，可选。 */
  project?: string;
}

interface OpenAIResponsePayload {
  id?: string;
  status?: string;
  output_text?: string;
  output?: unknown[];
  usage?: unknown;
  error?: unknown;
}

interface OpenAIToolState {
  id: string;
  toolName: string;
}

/** OpenAI 官方 Responses API Provider。 */
export class OpenAINativeProvider implements LlmProvider, ProviderRuntimeIntrospection {
  readonly id = "openai";
  readonly displayName = "OpenAI";
  readonly website = "https://openai.com";
  readonly icon = "openai";
  readonly models: readonly ModelDescriptor[] = OPENAI_NATIVE_MODELS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl?: RuntimeFetch;
  private readonly organization?: string;
  private readonly project?: string;

  constructor(config: OpenAINativeProviderConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://api.openai.com/v1");
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetch;
    this.organization = config.organization ?? process.env.OPENAI_ORG_ID;
    this.project = config.project ?? process.env.OPENAI_PROJECT_ID;
  }

  /** 非流式调用，适合标题生成、summary、小任务等不需要 token-by-token 展示的场景。 */
  async chat(request: ChatCompletionRequest): Promise<string> {
    const response = await this.createResponse(request, false);
    const payload = await readJson<OpenAIResponsePayload>(this.id, response, request.requestId);
    this.assertResponseNotFailed(payload, request.requestId);
    return extractOpenAIText(payload);
  }

  /** 流式调用，输出统一 ChatCompletionChunk，供 orchestrator 转成 EmaStreamEvent。 */
  async *chatStream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const response = await this.createResponse(request, true);
    const toolStates = new Map<string, OpenAIToolState>();
    let finalUsage: ChatCompletionChunk["usage"] | undefined;
    let sawToolCall = false;
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

      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const toolState = readOpenAIToolState(event);
        if (toolState) {
          sawToolCall = true;
          toolStates.set(toolState.id, toolState);
        }
        continue;
      }

      if (type === "response.output_text.delta") {
        const delta = readString(event, "delta");
        if (delta) {
          yield {
            index: readNumber(event, "output_index") ?? 0,
            delta: { content: delta },
            token: delta,
          };
        }
        continue;
      }

      if (type === "response.function_call_arguments.delta") {
        const itemId = readString(event, "item_id") ?? readString(event, "output_item_id") ?? readString(event, "call_id");
        const delta = readString(event, "delta") ?? "";
        const state = itemId ? toolStates.get(itemId) : undefined;
        sawToolCall = true;

        yield {
          index: readNumber(event, "output_index") ?? 0,
          delta: {},
          toolCalls: [
            {
              id: state?.id ?? itemId ?? "unknown_call",
              toolName: state?.toolName ?? "unknown_tool",
              argumentsDelta: delta,
            },
          ],
        };
        continue;
      }

      if (type === "response.completed") {
        const completedResponse = asRecord(event.response);
        finalUsage = normalizeOpenAIUsage(completedResponse?.usage);
        yield {
          index: 0,
          delta: {},
          usage: finalUsage,
          finishReason: sawToolCall ? "tool_calls" : "stop",
        };
        finalSent = true;
        continue;
      }

      if (type === "response.failed" || type === "response.incomplete") {
        throw buildOpenAIStreamError(event, request.requestId);
      }
    }

    // 某些代理网关可能只发送 [DONE] 而没有 completed 事件；这里给上层一个明确结束块。
    if (!finalSent) {
      yield {
        index: 0,
        delta: {},
        usage: finalUsage,
        finishReason: sawToolCall ? "tool_calls" : "stop",
      };
    }
  }

  /** 轻量健康检查：调用 /models，设置页可以用它判断 API key 和网络是否可用。 */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const startedAt = Date.now();
    const models = await this.listRemoteModels();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: `${models.length} models returned.`,
    };
  }

  /** OpenAI Models API，供后续 model catalog 刷新使用。 */
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

  private async createResponse(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    this.ensureApiKey();
    return postJson({
      providerId: this.id,
      url: joinUrl(this.baseUrl, "/responses"),
      headers: this.buildHeaders(stream ? "text/event-stream" : "application/json"),
      body: buildOpenAIResponsePayload(request, stream),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      requestId: request.requestId,
    });
  }

  private ensureApiKey(): void {
    if (!this.apiKey) {
      throw missingApiKeyError(this.id, "OPENAI_API_KEY");
    }
  }

  private buildHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "Accept": accept,
    };

    if (this.organization) {
      headers["OpenAI-Organization"] = this.organization;
    }
    if (this.project) {
      headers["OpenAI-Project"] = this.project;
    }

    return headers;
  }

  private assertResponseNotFailed(payload: OpenAIResponsePayload, requestId?: string): void {
    if (payload.status === "failed" || payload.error) {
      throw buildOpenAIStreamError({ type: "response.failed", response: payload }, requestId);
    }
  }
}

/** 兼容旧入口名；新代码建议使用 OpenAINativeProvider。 */
export { OpenAINativeProvider as OpenAIProvider };

function buildOpenAIResponsePayload(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.modelId,
    input: mapOpenAIInput(request.messages),
    stream,
    // 本地优先产品默认不让 provider 保存数据；如果未来要打开，应该走 config-kernel。
    store: false,
  };

  if (request.temperature !== undefined) {
    payload.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    payload.max_output_tokens = request.maxTokens;
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map(mapOpenAITool);
  }
  if (request.requestId || request.sessionId || request.traceId) {
    payload.metadata = {
      request_id: request.requestId,
      session_id: request.sessionId,
      trace_id: request.traceId,
    };
  }

  return payload;
}

function mapOpenAIInput(messages: readonly ChatCompletionMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      if (message.toolCallId) {
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        });
      } else {
        input.push({ role: "user", content: `[tool output]\n${message.content}` });
      }
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content.trim()) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.toolName,
          arguments: call.argumentsDelta,
        });
      }
      continue;
    }

    input.push({
      role: message.role,
      content: message.content,
    });
  }

  return input;
}

function mapOpenAITool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function extractOpenAIText(payload: OpenAIResponsePayload): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    const itemRecord = asRecord(item);
    const contentBlocks = Array.isArray(itemRecord?.content) ? itemRecord.content : [];
    for (const block of contentBlocks) {
      const blockRecord = asRecord(block);
      const text = readString(blockRecord, "text");
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("");
}

function readOpenAIToolState(event: Record<string, unknown>): OpenAIToolState | undefined {
  const item = asRecord(event.item);
  if (item?.type !== "function_call") {
    return undefined;
  }

  const itemId = readString(item, "id");
  const callId = readString(item, "call_id") ?? itemId;
  const name = readString(item, "name");
  if (!callId || !name) {
    return undefined;
  }

  return {
    id: callId,
    toolName: name,
  };
}

function buildOpenAIStreamError(event: Record<string, unknown>, requestId?: string): LlmProviderError {
  const response = asRecord(event.response);
  const error = asRecord(response?.error) ?? asRecord(event.error);
  const message = readString(error, "message") ?? "OpenAI response failed.";
  const providerCode = readString(error, "code") ?? readString(error, "type");

  return new LlmProviderError(message, {
    providerId: "openai",
    code: providerCode === "rate_limit_exceeded" ? "rate_limited" : "provider_internal",
    requestId,
    providerCode,
    retryable: providerCode === "rate_limit_exceeded",
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
