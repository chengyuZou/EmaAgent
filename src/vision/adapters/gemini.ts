// 将视觉提取请求转换为 Gemini generateContent 格式，只接受 bytes/base64 或受支持的文件 URI。

import { GoogleGenAI } from '@google/genai';
import type { Part } from '@google/genai';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import { VisionError, classifyVisionError } from '../errors.js';
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
 * 把 VisionImageInput 转成 Gemini Part。
 *
 * Gemini inlineData 直接接受 base64。URL 输入只有用 Cloud Storage URI
 * （gs://...）或 Files API 时才支持。普通 HTTP URL 走 inlineData 不接受，
 * 所以这里跳过并给警告。实际中 KB OCR 和附件视觉都是 bytes/base64。
 */
function toGeminiPart(
  input: VisionImageInput,
  context: {
    providerId: string;
    model: string;
    task: VisionAdapterCall['task'];
    invocationContext?: VisionAdapterCall['context'];
  },
): Part {
  switch (input.kind) {
    case 'bytes':
      return { inlineData: { mimeType: input.mimeType, data: Buffer.from(input.bytes).toString('base64') } };
    case 'base64':
      return { inlineData: { mimeType: input.mimeType, data: input.data } };
    case 'url':
      // 只有 gs:// 或 Files API URI 能用于 Gemini；其他 URL 必须整体失败，不能静默漏图。
      if (input.url.startsWith('gs://') || input.url.includes('generativelanguage.googleapis.com')) {
        return { fileData: { mimeType: input.mimeType ?? 'image/jpeg', fileUri: input.url } };
      }
      throw new VisionError(
        'vision/unsupported_input',
        'Gemini Vision only accepts bytes, base64, gs://, or Gemini Files API inputs',
        { ...context, retryable: false, details: { source: input.source ?? { url: input.url } } },
      );
  }
}

function sourceForInput(input: VisionImageInput): VisionSourceRef {
  if (input.source) return input.source;
  if (input.kind === 'url') return { url: input.url, label: input.name };
  return { label: input.name };
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  return baseUrl.replace(/\/+$/, '').replace(/\/v1(beta|alpha)?$/, '');
}

export class GeminiVisionAdapter implements VisionAdapter {
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: VisionProviderConfig) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    this.ai = new GoogleGenAI({
      apiKey: config.apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });
  }

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    const prompt = buildVisionExtractionPrompt({
      task:              request.task,
      language:          request.language,
      imageCount:        request.inputs.length,
      customInstruction: request.prompt,
    });

    const errorContext = {
      providerId: request.providerId,
      model: request.model,
      task: request.task,
      invocationContext: request.context,
    };
    const imageParts = request.inputs.map((input) => toGeminiPart(input, errorContext));

    const parts: Part[] = [{ text: prompt }, ...imageParts];

    let response;
    try {
      response = await this.ai.models.generateContent({
        model:    request.model,
        contents: [{ role: 'user', parts }],
        config: {
          maxOutputTokens: request.maxTokens ?? defaultMaxTokensForVisionTask(request.task),
          temperature:     request.temperature ?? 0,
          abortSignal:     request.signal,
        },
      });
    } catch (err) {
      throw classifyVisionError(err, errorContext);
    }

    const rawText = response.text ?? '';
    const parsed  = parseVisionPayload(rawText, { mode: request.parseMode });

    const usage = response.usageMetadata;

    return {
      context:   request.context,
      providerId: request.providerId,
      model:     request.model,
      task:      request.task,
      text:      parsed.text,
      ...(parsed.markdown ? { markdown: parsed.markdown } : {}),
      blocks:    parsed.blocks,
      sources:   request.inputs.map(sourceForInput),
      ...(usage ? {
        usage: {
          inputTokens:  usage.promptTokenCount  ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
        },
      } : {}),
      ...(parsed.warnings ? { warnings: parsed.warnings } : {}),
      rawText,
    };
  }

  async probe(model: string, signal?: AbortSignal): Promise<VisionProbeResult> {
    const startedAt = Date.now();
    try {
      await this.ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: 'Return {"text":"ok","blocks":[]} as JSON.' }] }],
        config: { maxOutputTokens: 16, abortSignal: signal },
      });
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
