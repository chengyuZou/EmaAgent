import { GoogleGenAI } from '@google/genai';
import type { Part } from '@google/genai';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import { VisionError } from '../errors.js';
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
 * Convert VisionImageInput to a Gemini Part.
 *
 * Gemini inlineData accepts base64 directly. URL inputs are only supported
 * when using Cloud Storage URIs (gs://...) or the Files API. Plain HTTP URLs
 * are not accepted by the inlineData path, so we skip them with a warning.
 * In practice, KB OCR and attachment vision always arrive as bytes/base64.
 */
function toGeminiPart(input: VisionImageInput): Part | null {
  switch (input.kind) {
    case 'bytes':
      return { inlineData: { mimeType: input.mimeType, data: Buffer.from(input.bytes).toString('base64') } };
    case 'base64':
      return { inlineData: { mimeType: input.mimeType, data: input.data } };
    case 'url':
      // Only gs:// / Files API URIs work with Gemini; skip HTTP URLs.
      if (input.url.startsWith('gs://') || input.url.includes('generativelanguage.googleapis.com')) {
        return { fileData: { mimeType: input.mimeType ?? 'image/jpeg', fileUri: input.url } };
      }
      return null;
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

    const imageParts: Part[] = request.inputs
      .map(toGeminiPart)
      .filter((p): p is Part => p !== null);

    if (imageParts.length === 0) {
      throw new VisionError('vision/invalid_request', 'No usable image parts after conversion (Gemini requires bytes/base64 or gs:// URLs)', {
        meta: { providerId: request.providerId, model: request.model, task: request.task, context: request.context, retryable: false },
      });
    }

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
      throw new VisionError('vision/provider_failed', `Gemini vision error: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
        meta: { providerId: request.providerId, model: request.model, task: request.task, context: request.context, retryable: false },
      });
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
      return { ok: false, latencyMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

