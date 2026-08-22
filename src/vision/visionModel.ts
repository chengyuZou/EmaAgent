// 创建点冻结连接与模型身份的视觉调用入口，并统一校验中立请求与结果。
import { VisionError } from './errors.js';
import { createAnthropicVisionProtocol } from './protocols/anthropic.js';
import { createGeminiVisionProtocol } from './protocols/gemini.js';
import { createOpenAiVisionProtocol } from './protocols/openAi.js';
import type {
  CallVision,
  VisionConnection,
  VisionProtocolRequest,
  VisionResult,
} from './types.js';

/** Vision 唯一创建入口；modelId 在此冻结，请求只执行一次，超时和重试由调用方通过 signal 控制。 */
export function createVisionCall(connection: VisionConnection, modelId: string): CallVision {
  if (!modelId.trim()) throw new VisionError('vision/invalid_request', 'Vision model must not be empty');
  const protocolAnalyze = createProtocolAnalyze(connection, modelId);
  return async (request) => {
    validateRequest(request);
    const result = await protocolAnalyze({ ...request, task: request.task ?? 'auto' });
    validateResult(result);
    return result;
  };
}

function createProtocolAnalyze(
  connection: VisionConnection,
  modelId: string,
): (request: VisionProtocolRequest) => Promise<VisionResult> {
  switch (connection.protocol) {
    case 'openai-vision': return createOpenAiVisionProtocol(connection, modelId);
    case 'anthropic-vision': return createAnthropicVisionProtocol(connection, modelId);
    case 'gemini-vision': return createGeminiVisionProtocol(connection, modelId);
  }
}

function validateRequest(request: Parameters<CallVision>[0]): void {
  if (request.images.length === 0) {
    throw new VisionError('vision/invalid_request', 'Vision request must contain at least one image');
  }
  for (const image of request.images) {
    if (image.kind === 'bytes' && image.bytes.byteLength === 0) {
      throw new VisionError('vision/invalid_request', 'Vision image bytes must not be empty');
    }
    if (image.kind === 'base64' && !stripBase64Prefix(image.data)) {
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
  if (
    result.usage
    && (
      !Number.isFinite(result.usage.inputTokens)
      || !Number.isFinite(result.usage.outputTokens)
      || result.usage.inputTokens < 0
      || result.usage.outputTokens < 0
    )
  ) {
    throw new VisionError('vision/invalid_response', 'Vision provider returned invalid usage');
  }
}

function stripBase64Prefix(data: string): string {
  return data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
}
