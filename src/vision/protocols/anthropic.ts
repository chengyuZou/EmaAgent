// 把中立视觉请求转换为 Anthropic Messages 图像输入。
import Anthropic from '@anthropic-ai/sdk';
import { throwVisionProtocolError } from '../errors.js';
import { parseVisionResult } from '../parse.js';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import type {
  VisionConnection,
  VisionImage,
  VisionProtocolRequest,
  VisionResult,
} from '../types.js';

export function createAnthropicVisionProtocol(
  connection: VisionConnection, modelId: string,
): (request: VisionProtocolRequest) => Promise<VisionResult> {
  const client = new Anthropic({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    maxRetries: 0,
  });
  return (request) => analyzeAnthropic(client, modelId, request);
}

async function analyzeAnthropic(
  client: Anthropic,
  modelId: string,
  request: VisionProtocolRequest,
): Promise<VisionResult> {
  const content: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: buildPrompt(request) },
    ...request.images.map(toAnthropicImage),
  ];
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: modelId,
      messages: [{ role: 'user', content }],
      max_tokens: request.maxOutputTokens ?? defaultMaxTokensForVisionTask(request.task),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }, { signal: request.signal });
  } catch (error) {
    throwVisionProtocolError(error);
  }

  const raw = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return {
    ...parseVisionResult(raw),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

function toAnthropicImage(image: VisionImage): Anthropic.ImageBlockParam {
  if (image.kind === 'url') {
    return { type: 'image', source: { type: 'url', url: image.url } };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mimeType as Anthropic.Base64ImageSource['media_type'],
      data: image.kind === 'bytes'
        ? Buffer.from(image.bytes).toString('base64')
        : cleanBase64(image.data),
    },
  };
}

function buildPrompt(request: VisionProtocolRequest): string {
  return buildVisionExtractionPrompt({
    task: request.task,
    language: request.language,
    imageCount: request.images.length,
    instruction: request.instruction,
  });
}

function cleanBase64(data: string): string {
  return data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
}
