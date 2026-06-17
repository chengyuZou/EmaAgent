import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import { VisionError, type VisionErrorCode, type VisionErrorMeta } from '../errors.js';
import { parseVisionPayload } from '../parse.js';
import type { VisionAdapter, VisionAdapterCall } from './base.js';
import type {
  VisionExtractionResult,
  VisionImageInput,
  VisionProbeResult,
  VisionProviderConfig,
  VisionSourceRef,
} from '../types.js';

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

type OpenAiVisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiVisionAdapter implements VisionAdapter {
  private readonly baseUrl: string;

  constructor(private readonly config: VisionProviderConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  }

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    const meta: VisionErrorMeta = {
      providerId: request.providerId,
      model: request.model,
      task: request.task,
      context: request.context,
    };
    const prompt = buildVisionExtractionPrompt({
      task: request.task,
      language: request.language,
      imageCount: request.inputs.length,
      customInstruction: request.prompt,
    });
    const content: OpenAiVisionContentPart[] = [
      { type: 'text', text: prompt },
      ...request.inputs.map(toOpenAiImagePart),
    ];

    const response = await this.postChatCompletion(
      {
        model: request.model,
        messages: [{ role: 'user', content }],
        max_tokens: request.maxTokens ?? defaultMaxTokensForVisionTask(request.task),
        temperature: request.temperature ?? 0,
      },
      request.signal,
      meta,
    );
    const rawText = extractText(response);
    const parsed = parseVisionPayload(rawText, { mode: request.parseMode });

    return {
      context: request.context,
      providerId: request.providerId,
      model: request.model,
      task: request.task,
      text: parsed.text,
      ...(parsed.markdown ? { markdown: parsed.markdown } : {}),
      blocks: parsed.blocks,
      sources: request.inputs.map(sourceForInput),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      ...(parsed.warnings ? { warnings: parsed.warnings } : {}),
      rawText,
    };
  }

  async probe(model: string, signal?: AbortSignal): Promise<VisionProbeResult> {
    const startedAt = Date.now();
    const meta: VisionErrorMeta = {
      providerId: this.config.id,
      model,
      task: 'probe',
    };
    try {
      await this.postChatCompletion(
        {
          model,
          messages: [{
            role: 'user',
            content: [{
              type: 'text',
              text: 'Return {"text":"ok","blocks":[]} as JSON.',
            }],
          }],
          max_tokens: 16,
          temperature: 0,
        },
        signal,
        meta,
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, latencyMs: Date.now() - startedAt, error: message };
    }
  }

  private async postChatCompletion(
    body: unknown,
    signal: AbortSignal | undefined,
    meta: VisionErrorMeta,
  ): Promise<OpenAiChatCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw providerHttpError(response.status, text, meta);
    }

    try {
      return JSON.parse(text) as OpenAiChatCompletionResponse;
    } catch (error) {
      throw new VisionError('vision/provider_failed', 'Vision provider returned invalid JSON', {
        cause: error,
        details: { responseText: text.slice(0, 2000) },
        meta: { ...meta, retryable: false },
      });
    }
  }
}

function toOpenAiImagePart(input: VisionImageInput): OpenAiVisionContentPart {
  switch (input.kind) {
    case 'url':
      return { type: 'image_url', image_url: { url: input.url } };
    case 'base64':
      return {
        type: 'image_url',
        image_url: { url: dataUrl(input.mimeType, input.data) },
      };
    case 'bytes':
      return {
        type: 'image_url',
        image_url: { url: dataUrl(input.mimeType, uint8ToBase64(input.bytes)) },
      };
  }
}

function extractText(response: OpenAiChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter((part) => part.length > 0)
      .join('\n');
  }
  return '';
}

function dataUrl(mimeType: string, base64: string): string {
  const trimmed = base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  return `data:${mimeType};base64,${trimmed}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16)
      | ((bytes[i + 1] ?? 0) << 8)
      | (bytes[i + 2] ?? 0);
    output += alphabet[(n >> 18) & 63] ?? '';
    output += alphabet[(n >> 12) & 63] ?? '';
    output += alphabet[(n >> 6) & 63] ?? '';
    output += alphabet[n & 63] ?? '';
  }

  if (i < bytes.length) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] ?? 0 : 0;
    const n = (a << 16) | (b << 8);
    output += alphabet[(n >> 18) & 63] ?? '';
    output += alphabet[(n >> 12) & 63] ?? '';
    output += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] ?? '' : '=';
    output += '=';
  }

  return output;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function providerHttpError(status: number, body: string, meta: VisionErrorMeta): VisionError {
  const { code, retryable } = classifyProviderHttpStatus(status);
  const message = body.length > 0
    ? `vision/provider_failed: provider HTTP ${status}: ${body.slice(0, 1000)}`
    : `vision/provider_failed: provider HTTP ${status}`;
  return new VisionError(code, message, {
    details: { status, responseText: body.slice(0, 2000) },
    meta: { ...meta, status, retryable },
  });
}

function classifyProviderHttpStatus(status: number): { code: VisionErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) {
    return { code: 'vision/auth_failed', retryable: false };
  }
  if (status === 413) {
    return { code: 'vision/context_too_large', retryable: false };
  }
  if (status === 429) {
    return { code: 'vision/rate_limited', retryable: true };
  }
  if (status === 408 || status >= 500) {
    return { code: 'vision/provider_unavailable', retryable: true };
  }
  return { code: 'vision/provider_failed', retryable: false };
}

function sourceForInput(input: VisionImageInput): VisionSourceRef {
  if (input.source) return input.source;
  switch (input.kind) {
    case 'url':
      return { url: input.url, label: input.name };
    case 'bytes':
    case 'base64':
      return { label: input.name };
  }
}
