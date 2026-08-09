// 把中立视觉请求转换为 OpenAI Chat Completions 图像输入。
import OpenAI from 'openai';
import { throwVisionProtocolError } from '../errors.js';
import { parseVisionResult } from '../parse.js';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import type {
  VisionConnection,
  VisionImage,
  VisionProtocolRequest,
  VisionResult,
} from '../types.js';

export function createOpenAiVisionProtocol(
  connection: VisionConnection,
): (request: VisionProtocolRequest) => Promise<VisionResult> {
  const client = new OpenAI({
    apiKey: connection.apiKey ?? '',
    baseURL: connection.baseUrl,
    maxRetries: 0,
  });
  return (request) => analyzeOpenAi(client, request);
}

async function analyzeOpenAi(
  client: OpenAI,
  request: VisionProtocolRequest,
): Promise<VisionResult> {
  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: 'text', text: buildPrompt(request) },
    ...request.images.map(toOpenAiImage),
  ];
  let response: OpenAI.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: request.model,
      messages: [{ role: 'user', content }],
      max_tokens: request.maxOutputTokens ?? defaultMaxTokensForVisionTask(request.task),
      temperature: request.temperature ?? 0,
    }, { signal: request.signal });
  } catch (error) {
    throwVisionProtocolError(error);
  }

  const raw = response.choices[0]?.message.content ?? '';
  const parsed = parseVisionResult(raw);
  return {
    ...parsed,
    ...(response.usage
      ? {
          usage: {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          },
        }
      : {}),
  };
}

function toOpenAiImage(image: VisionImage): OpenAI.ChatCompletionContentPartImage {
  if (image.kind === 'url') return { type: 'image_url', image_url: { url: image.url } };
  const data = image.kind === 'bytes'
    ? Buffer.from(image.bytes).toString('base64')
    : cleanBase64(image.data);
  return { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${data}` } };
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
