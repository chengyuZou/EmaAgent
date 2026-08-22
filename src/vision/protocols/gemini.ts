// 把中立视觉请求转换为 Gemini generateContent 图像输入。
import { GoogleGenAI, type Part } from '@google/genai';
import { VisionError, throwVisionProtocolError } from '../errors.js';
import { parseVisionResult } from '../parse.js';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';
import type {
  VisionConnection,
  VisionImage,
  VisionProtocolRequest,
  VisionResult,
} from '../types.js';

export function createGeminiVisionProtocol(
  connection: VisionConnection, modelId: string,
): (request: VisionProtocolRequest) => Promise<VisionResult> {
  const baseUrl = normalizeBaseUrl(connection.baseUrl);
  const client = new GoogleGenAI({
    apiKey: connection.apiKey ?? '',
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });
  return (request) => analyzeGemini(client, modelId, request);
}

async function analyzeGemini(
  client: GoogleGenAI,
  modelId: string,
  request: VisionProtocolRequest,
): Promise<VisionResult> {
  const parts: Part[] = [
    { text: buildPrompt(request) },
    ...request.images.map(toGeminiImage),
  ];
  let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
  try {
    response = await client.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts }],
      config: {
        maxOutputTokens: request.maxOutputTokens ?? defaultMaxTokensForVisionTask(request.task),
        temperature: request.temperature ?? 0,
        abortSignal: request.signal,
      },
    });
  } catch (error) {
    throwVisionProtocolError(error);
  }

  const usage = response.usageMetadata;
  return {
    ...parseVisionResult(response.text ?? ''),
    ...(usage
      ? {
          usage: {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
          },
        }
      : {}),
  };
}

function toGeminiImage(image: VisionImage): Part {
  if (image.kind === 'bytes') {
    return {
      inlineData: {
        mimeType: image.mimeType,
        data: Buffer.from(image.bytes).toString('base64'),
      },
    };
  }
  if (image.kind === 'base64') {
    return { inlineData: { mimeType: image.mimeType, data: cleanBase64(image.data) } };
  }
  if (image.url.startsWith('gs://') || image.url.includes('generativelanguage.googleapis.com')) {
    return {
      fileData: {
        mimeType: image.mimeType ?? 'image/jpeg',
        fileUri: image.url,
      },
    };
  }
  throw new VisionError(
    'vision/unsupported_input',
    'gemini-vision only accepts bytes, base64, gs://, or Gemini Files API images',
  );
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

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl?.replace(/\/+$/, '').replace(/\/v1(beta|alpha)?$/, '');
}
