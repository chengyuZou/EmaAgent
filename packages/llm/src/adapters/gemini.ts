import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import type {
  GenerateContentConfig,
  GenerateContentResponse,
  Content,
  Part,
  ToolConfig,
  FunctionDeclaration,
  ThinkingConfig,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest, LlmStreamChunk, LlmMessage, LlmToolDef,
  StopReason, ProviderConfig, AssistantBlock, UserBlock,
} from '../types.js';
import type { ToolResultBlock, MessageContentPart } from '@ema-agent/contracts';

// ── Stop reason ────────────────────────────────────────────────────────────────

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'STOP':                    return 'end_turn';
    case 'MAX_TOKENS':              return 'max_tokens';
    // 以下都是非正常结束，统一映射成 stop_sequence 让上游知道不是正常完成
    case 'SAFETY':
    case 'RECITATION':
    case 'LANGUAGE':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'MALFORMED_FUNCTION_CALL': return 'stop_sequence';
    default:                        return 'end_turn';
  }
}

// ── Message conversion ────────────────────────────────────────────────────────

function mediaPartToGeminiPart(part: MessageContentPart): Part | null {
  switch (part.type) {
    case 'text':
      return { text: part.text };

    case 'image_data':
    case 'audio_data':
    case 'file_data':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };

    case 'image_url':
      // validate.ts 已经确保只有 gs:// 或 Files API URI 能到这里
      return { fileData: { mimeType: mimeFromUri(part.url), fileUri: part.url } };

    case 'file_url':
      return { fileData: { mimeType: part.mimeType, fileUri: part.url } };
  }
}

function mimeFromUri(uri: string): string {
  let path = uri;

  try {
    path = new URL(uri).pathname;
  } catch {
    // gs://xxx/a.png 不是标准 URL 也没关系，直接用原字符串
  }

  const lower = path.toLowerCase();

  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';

  return 'application/octet-stream';
}

function toGeminiContents(
  msgs: LlmMessage[],
): { system: string | undefined; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];

  // 先扫一遍 assistant 消息建立 callId → functionName 映射
  // （Gemini functionResponse 需要 name 字段对应 functionCall.name）
  const callIdToName = new Map<string, string>();
  for (const msg of msgs) {
    if (msg.role === 'assistant') {
      for (const block of msg.content as AssistantBlock[]) {
        if (block.type === 'tool_use') {
          callIdToName.set(block.id, block.name);
        }
      }
    }
  }

  for (const msg of msgs) {
    if (msg.role === 'system') {
      // 多条 system 消息合并（不像旧代码只保留最后一条）
      system = system ? `${system}\n\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
        continue;
      }

      const parts: Part[] = [];
      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          const name = callIdToName.get(tb.toolUseId) ?? tb.toolUseId;
          let response: Record<string, unknown>;
          try {
            response = typeof tb.content === 'string'
              ? JSON.parse(tb.content) as Record<string, unknown>
              : { content: tb.content };
          } catch {
            response = { content: tb.content };
          }
          parts.push({ functionResponse: { name, response } });
        } else {
          const p = mediaPartToGeminiPart(block as MessageContentPart);
          if (p) parts.push(p);
        }
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
      continue;
    }

    // assistant → model
    const parts: Part[] = [];
    for (const block of msg.content as AssistantBlock[]) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: {
            name: block.name,
            args: block.args as Record<string, unknown>,
          },
        });
      }
      // thinking 在 Gemini 里是 thinkingConfig 控制，历史消息里直接跳过
    }
    if (parts.length > 0) contents.push({ role: 'model', parts });
  }

  return { system, contents };
}

// ── Tool conversion ───────────────────────────────────────────────────────────

function toGeminiFunctionDeclaration(tool: LlmToolDef): FunctionDeclaration {
  // 剥掉 Gemini 不认识的 JSON Schema 字段
  const { $schema, ...parametersJsonSchema } = tool.parameters as Record<string, unknown>;
  void $schema;
  return { name: tool.name, description: tool.description, parametersJsonSchema };
}

function toGeminiToolConfig(tc: LlmRequest['toolChoice']): ToolConfig | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  if (tc === 'none')    return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [tc.name] } };
}

function normalizeGeminiNativeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;

  const clean = baseUrl.replace(/\/+$/, '');

  if (clean.endsWith('/openai') || clean.includes('/openai/')) {
    throw new Error(
      'GeminiAdapter uses the native Gemini protocol. ' +
      'Do not pass an OpenAI-compatible /openai baseUrl here. ' +
      'Use the OpenAI-compatible adapter instead.',
    );
  }

  // @google/genai 会自己拼 apiVersion/models/...
  // 如果用户填了官方 OpenAI-compatible 那种 /v1beta/openai 肯定错；
  // 如果用户填 native root 时带了 /v1beta，也建议剥掉，避免部分网关双拼版本号。
  return clean.replace(/\/v1(beta|alpha)?$/, '');
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class GeminiAdapter implements LlmAdapter {
  private readonly ai: GoogleGenAI;

  constructor(config: ProviderConfig) {
    const baseUrl = normalizeGeminiNativeBaseUrl(config.baseUrl);
    this.ai = new GoogleGenAI({
      apiKey: config.apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    const { system, contents } = toGeminiContents(request.messages);

    const config: GenerateContentConfig = {
      maxOutputTokens: request.maxTokens,
      temperature:     request.temperature,
      abortSignal:     request.signal,
    };

    if (system) config.systemInstruction = system;

    if (request.tools?.length && request.toolChoice !== 'none') {
      config.tools = [{
        functionDeclarations: request.tools.map(toGeminiFunctionDeclaration),
      }];
      const tc = toGeminiToolConfig(request.toolChoice);
      if (tc) config.toolConfig = tc;
    }

    if (request.thinking?.enabled === true) {
      const tc: ThinkingConfig = {
        includeThoughts:  true,
        thinkingBudget:   (request.thinking as { budgetTokens?: number }).budgetTokens ?? 8000,
      };
      config.thinkingConfig = tc;
    } else if (request.thinking?.enabled === false) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }

    let responseStream: AsyncGenerator<GenerateContentResponse>;
    let lastUsage:
      | { inputTokens: number; outputTokens: number }
      | undefined;

    try {
      responseStream = await this.ai.models.generateContentStream({
        model:    modelName,
        contents,
        config,
      });
    } catch (err) {
      // NOTE:
      // On user abort we intentionally do NOT emit usage.
      // For streaming requests, provider usage is only reliable after normal completion.
      // If the request is aborted midway, partial usage may be missing or inaccurate.
      // Upstream billing/telemetry should treat aborted runs as "usage unavailable".
      if (request.signal?.aborted) {
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }
      throw err;
    }

    let stopReason: StopReason = 'end_turn';
    let toolBlockIdx = 0;
    let hasThinking  = false;

    try {
      for await (const chunk of responseStream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];

        for (const part of parts) {
          if (part.thought && part.text) {
            hasThinking = true;
            yield { type: 'thinking_delta', blockIndex: 0, delta: part.text };
            continue;
          }
          if (part.text) {
            yield { type: 'text_delta', blockIndex: hasThinking ? 1 : 0, delta: part.text };
          }
          if (part.functionCall) {
            const name = part.functionCall.name;
            if (!name) {
              throw new Error('Gemini returned a functionCall without name.')
            }
            const callId     = `gemini-${randomUUID()}`;
            const blockIndex = 1000 + toolBlockIdx++;
            yield {
              type:  'tool_use_complete',
              blockIndex,
              callId,
              name:  name,
              args:  part.functionCall.args  ?? {},
            };
            stopReason = 'tool_use';
          }
        }

        const finishReason = chunk.candidates?.[0]?.finishReason;
        if (finishReason && String(finishReason) !== 'FINISH_REASON_UNSPECIFIED') {
          const mapped = mapStopReason(String(finishReason));
          // 只在还没因 tool_use 停止时才更新
          if (stopReason === 'end_turn') stopReason = mapped;
        }

        if (chunk.usageMetadata) {
          lastUsage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      }
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: 'done', stopReason };
        return;
      }
      throw err;
    }

    if (lastUsage) {
      yield { type: 'usage', ...lastUsage };
    }
    yield { type: 'done', stopReason };
  }
}