// 将视觉提取请求转换为 OpenAI Chat Completions 格式，并用 Buffer 编码 bytes 图片。

import OpenAI from 'openai';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import { classifyVisionError } from '../errors.js';
import { parseVisionPayload } from '../parse.js';
import type { VisionAdapter, VisionAdapterCall } from './base.js';
import type {
  VisionExtractionResult,
  VisionImageInput,
  VisionProbeResult,
  VisionProviderConfig,
  VisionSourceRef,
} from '../types.js';

/**
 * 把 VisionImageInput 转成 OpenAI Chat Completions 的 image_url content part。
 * bytes 用 Buffer 转 base64(替代手写 uint8ToBase64),再拼成 data URL。
 */
function toOpenAiImagePart(input: VisionImageInput): OpenAI.ChatCompletionContentPart {
  switch (input.kind) {
    case 'url':
      return { type: 'image_url', image_url: { url: input.url } };
    case 'base64':
      return { type: 'image_url', image_url: { url: dataUrl(input.mimeType, input.data) } };
    case 'bytes':
      return {
        type: 'image_url',
        image_url: { url: dataUrl(input.mimeType, Buffer.from(input.bytes).toString('base64')) },
      };
  }
}

/** 拼成 data URL；剥掉可能已有的 data: 前缀和空白，避免重复前缀。 */
function dataUrl(mimeType: string, base64: string): string {
  const trimmed = base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  return `data:${mimeType};base64,${trimmed}`;
}

/** 从 OpenAI 响应里取文本:非流式 ChatCompletion 的 message.content 是 string | null。 */
function extractText(response: OpenAI.ChatCompletion): string {
  return response.choices?.[0]?.message?.content ?? '';
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

export class OpenAiVisionAdapter implements VisionAdapter {
  private readonly client: OpenAI;

  constructor(private readonly config: VisionProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    const meta = {
      providerId: request.providerId,
      model: request.model,
      task: request.task,
      invocationContext: request.context,
    };
    const prompt = buildVisionExtractionPrompt({
      task:              request.task,
      language:          request.language,
      imageCount:        request.inputs.length,
      customInstruction: request.prompt,
    });
    const content: OpenAI.ChatCompletionContentPart[] = [
      { type: 'text', text: prompt },
      ...request.inputs.map(toOpenAiImagePart),
    ];

    let response: OpenAI.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(
        {
          model:       request.model,
          messages:    [{ role: 'user', content }],
          max_tokens:  request.maxTokens ?? defaultMaxTokensForVisionTask(request.task),
          temperature: request.temperature ?? 0,
        },
        { signal: request.signal },
      );
    } catch (err) {
      // SDK 抛的错带 status 字段,classifyVisionError 按 HTTP 状态/关键词分类
      // (401->auth / 413->context_too_large / 429->rate_limited / 5xx->provider_unavailable),
      // 替代原来手写的 classifyProviderHttpStatus。
      throw classifyVisionError(err, meta);
    }

    const rawText = extractText(response);
    const parsed  = parseVisionPayload(rawText, { mode: request.parseMode });

    return {
      context:   request.context,
      providerId: request.providerId,
      model:     request.model,
      task:      request.task,
      text:      parsed.text,
      ...(parsed.markdown ? { markdown: parsed.markdown } : {}),
      blocks:    parsed.blocks,
      sources:   request.inputs.map(sourceForInput),
      usage: {
        inputTokens:  response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      ...(parsed.warnings ? { warnings: parsed.warnings } : {}),
      rawText,
    };
  }

  async probe(model: string, signal?: AbortSignal): Promise<VisionProbeResult> {
    const startedAt = Date.now();
    try {
      await this.client.chat.completions.create(
        {
          model,
          messages: [{
            role:    'user',
            content: [{ type: 'text', text: 'Return {"text":"ok","blocks":[]} as JSON.' }],
          }],
          max_tokens:  16,
          temperature: 0,
        },
        { signal },
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: classifyVisionError(err, { providerId: this.config.id, model }).code,
      };
    }
  }
}
