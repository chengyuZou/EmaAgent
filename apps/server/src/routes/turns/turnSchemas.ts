// 定义 Turn HTTP 请求的解码、字段限制和领域契约漂移检查。

import type { Context } from 'hono';
import { z } from 'zod';
import {
  hasTurnRequestInput,
  type TurnRequest,
} from '@ema-agent/turn';
import { REQUEST_VALUE_LIMITS } from '../../http/request-budget.js';

/**
 * WebView 在部分 Windows 环境中可能提交非 UTF-8 JSON。
 * 优先按 UTF-8 解码，检测到替换字符时再尝试 GBK，避免正常 UTF-8 请求被误判。
 */
export async function readTurnJsonBody(context: Context): Promise<unknown> {
  const buffer = await context.req.raw.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return null;

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8.includes('\uFFFD')) return JSON.parse(utf8);

  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes);
    return JSON.parse(gbk);
  } catch {
    return JSON.parse(utf8);
  }
}

export const attachmentInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
  fileHandle: z.string().min(1).max(16_384),
});

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), url: z.string() }),
  z.object({
    type: z.literal('image_data'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('audio_data'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('file_data'),
    data: z.string(),
    mimeType: z.string(),
    filename: z.string().optional(),
  }),
  z.object({
    type: z.literal('file_url'),
    url: z.string(),
    mimeType: z.string(),
    filename: z.string().optional(),
  }),
]);

export const turnBodySchema = z.object({
  sessionId: z.string().optional(),
  trigger: z.object({ type: z.literal('userMessage') }),
  executionProfile: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
  userInput: z.string().max(REQUEST_VALUE_LIMITS.maxTurnTextChars).optional(),
  contentParts: z.array(contentPartSchema)
    .max(REQUEST_VALUE_LIMITS.maxTurnContentParts)
    .optional(),
  attachments: z.array(attachmentInputSchema)
    .max(REQUEST_VALUE_LIMITS.maxTurnAttachments)
    .optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  ttsEnabled: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  kbIds: z.array(z.string())
    .max(REQUEST_VALUE_LIMITS.maxTurnKbIds)
    .optional(),
  kbAssetScopes: z.array(z.object({
    kbId: z.string(),
    assetIds: z.array(z.string()),
  }))
    .max(REQUEST_VALUE_LIMITS.maxTurnKbAssetScopes)
    .optional(),
}).refine(
  hasTurnRequestInput,
  { message: 'either userInput, contentParts, or attachments is required' },
);

type RequireTrue<T extends true> = T;
type TurnBodySchemaMatchesRequest = RequireTrue<
  z.infer<typeof turnBodySchema> extends TurnRequest ? true : false
>;

