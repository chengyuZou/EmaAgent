// 将视觉提取请求转换为 Anthropic Messages API 格式并调用官方 SDK。

import Anthropic from '@anthropic-ai/sdk';
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

function toAnthropicImageBlock(
  input: VisionImageInput,
): Anthropic.ImageBlockParam {
  switch (input.kind) {
    case 'url':
      return {
        type:   'image',
        source: { type: 'url', url: input.url },
      };
    case 'base64':
      return {
        type:   'image',
        source: {
          type:       'base64',
          media_type: input.mimeType as Anthropic.Base64ImageSource['media_type'],
          data:       input.data,
        },
      };
    case 'bytes':
      return {
        type:   'image',
        source: {
          type:       'base64',
          media_type: input.mimeType as Anthropic.Base64ImageSource['media_type'],
          data:       Buffer.from(input.bytes).toString('base64'),
        },
      };
  }
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function sourceForInput(input: VisionImageInput): VisionSourceRef {
  if (input.source) return input.source;
  if (input.kind === 'url') return { url: input.url, label: input.name };
  return { label: input.name };
}

export class AnthropicVisionAdapter implements VisionAdapter {
  private readonly client: Anthropic;

  constructor(private readonly config: VisionProviderConfig) {
    this.client = new Anthropic({
      apiKey:  config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    const prompt = buildVisionExtractionPrompt({
      task:              request.task,
      language:          request.language,
      imageCount:        request.inputs.length,
      customInstruction: request.prompt,
    });

    const content: Anthropic.ContentBlockParam[] = [
      { type: 'text', text: prompt },
      ...request.inputs.map(toAnthropicImageBlock),
    ];

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model:      request.model,
          messages:   [{ role: 'user', content }],
          max_tokens: request.maxTokens ?? defaultMaxTokensForVisionTask(request.task),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        { signal: request.signal },
      );
    } catch (err) {
      throw classifyVisionError(err, {
        providerId: request.providerId,
        model: request.model,
        task: request.task,
        invocationContext: request.context,
      });
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
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      ...(parsed.warnings ? { warnings: parsed.warnings } : {}),
      rawText,
    };
  }

  async probe(model: string, signal?: AbortSignal): Promise<VisionProbeResult> {
    const startedAt = Date.now();
    try {
      await this.client.messages.create(
        {
          model,
          messages: [{
            role:    'user',
            content: [{ type: 'text', text: 'Return {"text":"ok","blocks":[]} as JSON.' }],
          }],
          max_tokens: 16,
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
