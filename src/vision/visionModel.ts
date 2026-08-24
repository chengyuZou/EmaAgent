// 把一次视觉任务转换为无 Tool、无历史的 LLM 调用，并把模型文本解析为视觉结果。
import {
  createLlmCall,
  createLlmCompletion,
  type ContentPart,
  type LlmCompletion,
  type UserBlock,
} from '@ema-agent/llm';
import { VisionError } from './errors.js';
import { parseVisionResult } from './parse.js';
import {
  buildVisionExtractionPrompt,
  defaultMaxTokensForVisionTask,
} from './prompts.js';
import type {
  CallVision,
  VisionConnection,
  VisionImage,
  VisionRequest,
  VisionResult,
} from './types.js';

/** Vision 唯一创建入口；连接与模型身份在创建点冻结，每次调用只执行一次 LLM 请求。 */
export function createVisionCall(connection: VisionConnection, modelId: string): CallVision {
  if (!modelId.trim()) {
    throw new VisionError('vision/invalid_request', 'Vision model must not be empty');
  }
  const callLlm = createLlmCall(connection, modelId);

  return async (request) => {
    validateRequest(request);
    const task = request.task ?? 'auto';
    const content: UserBlock[] = [
      {
        type: 'text',
        text: buildVisionExtractionPrompt({
          task,
          language: request.language,
          imageCount: request.images.length,
          instruction: request.instruction,
        }),
      },
      ...request.images.map(image => toLlmImage(image, connection.protocol)),
    ];

    let completion: LlmCompletion;
    try {
      completion = await createLlmCompletion(callLlm({
        messages: [{ role: 'user', content }],
        thinking: { enabled: false },
        maxOutputTokens: request.maxOutputTokens ?? defaultMaxTokensForVisionTask(task),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        signal: request.signal,
      }));
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (error instanceof VisionError) throw error;
      throw new VisionError(
        'vision/call_failed',
        error instanceof Error ? error.message : String(error),
        statusOf(error),
        error,
      );
    }

    const result = resultFromCompletion(completion);
    validateResult(result);
    return result;
  };
}

function toLlmImage(
  image: VisionImage,
  protocol: VisionConnection['protocol'],
): ContentPart {
  if (image.kind === 'url') {
    if (protocol === 'gemini-llm' && /^https?:/i.test(image.url)) {
      throw new VisionError(
        'vision/unsupported_input',
        'gemini-llm only accepts Gemini Files API or gs:// image URLs',
      );
    }
    return { type: 'image_url', url: image.url };
  }
  return {
    type: 'image_data',
    data: image.kind === 'bytes'
      ? Buffer.from(image.bytes).toString('base64')
      : cleanBase64(image.data),
    mimeType: image.mimeType,
  };
}

function resultFromCompletion(completion: LlmCompletion): VisionResult {
  const raw = completion.blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  return {
    ...parseVisionResult(raw),
    usage: completion.usage,
  };
}

function validateRequest(request: VisionRequest): void {
  if (request.images.length === 0) {
    throw new VisionError('vision/invalid_request', 'Vision request must contain at least one image');
  }
  for (const image of request.images) {
    if (image.kind === 'bytes' && image.bytes.byteLength === 0) {
      throw new VisionError('vision/invalid_request', 'Vision image bytes must not be empty');
    }
    if (image.kind === 'base64' && !cleanBase64(image.data)) {
      throw new VisionError('vision/invalid_request', 'Vision base64 image must not be empty');
    }
    if (image.kind === 'url' && !image.url.trim()) {
      throw new VisionError('vision/invalid_request', 'Vision image URL must not be empty');
    }
  }
  if (
    request.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
  ) {
    throw new VisionError('vision/invalid_request', 'maxOutputTokens must be a positive integer');
  }
  if (request.temperature !== undefined && !Number.isFinite(request.temperature)) {
    throw new VisionError('vision/invalid_request', 'temperature must be finite');
  }
}

function validateResult(result: VisionResult): void {
  if (!result.text.trim() && result.blocks.length === 0) {
    throw new VisionError('vision/invalid_response', 'Vision provider returned no visible content');
  }
}

function cleanBase64(data: string): string {
  return data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' ? value : undefined;
}
