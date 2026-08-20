// POST /api/turns：解析 Wire 请求、定位或创建 Session、启动 Turn 并挂事件扇出。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import {
  hasTurnRequestInput,
  SessionBusyError,
  type TurnExecutor,
} from '@ema-agent/turn';
import { REQUEST_VALUE_LIMITS } from '../../platform/requestBudget.js';
import type { TurnFanout } from '../../sse/turnFanout.js';

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().max(REQUEST_VALUE_LIMITS.maxTurnTextChars),
  }),
  z.object({
    type: z.literal('image_url'),
    url: z.string().min(1),
    name: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    type: z.literal('image_data'),
    data: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    type: z.literal('audio_data'),
    data: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal('file_data'),
    data: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().optional(),
    pageCount: z.number().optional(),
  }),
  z.object({
    type: z.literal('file_url'),
    url: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().optional(),
    pageCount: z.number().optional(),
  }),
]);

const attachmentSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().optional(),
  mtime: z.number().optional(),
});

const startTurnBody = z.object({
  sessionId: z.string().min(1).optional(),
  executionProfile: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
  userInput: z.string().max(REQUEST_VALUE_LIMITS.maxTurnTextChars).optional(),
  contentParts: z.array(contentPartSchema).max(REQUEST_VALUE_LIMITS.maxTurnContentParts).optional(),
  attachments: z.array(attachmentSchema).max(REQUEST_VALUE_LIMITS.maxTurnAttachments).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  ttsEnabled: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  kbId: z.string().min(1).optional(),
  kbAssetIds: z.array(z.string().min(1)).max(REQUEST_VALUE_LIMITS.maxTurnKbAssetScopes).optional(),
});

export interface StartTurnRouteDeps {
  readonly executor: TurnExecutor;
  readonly fanout: TurnFanout;
  readonly session: Pick<SessionStore, 'createSession' | 'sessionExists'>;
}

export function startTurnRoute(deps: StartTurnRouteDeps): Hono {
  const app = new Hono();

  app.post('/', async context => {
    const parsed = startTurnBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;
    if (!hasTurnRequestInput(body)) {
      return context.json({ error: 'empty_input' }, 400);
    }

    const sessionId = body.sessionId ?? deps.session.createSession().id;
    if (!deps.session.sessionExists(sessionId)) {
      return context.json({ error: 'session_not_found' }, 404);
    }

    let handle;
    try {
      handle = deps.executor.start({
        sessionId,
        triggerType: 'userMessage',
        executionProfile: body.executionProfile,
        narrativePolicy: body.narrativePolicy,
        ...(body.userInput !== undefined ? { userInput: body.userInput } : {}),
        ...(body.contentParts ? { contentParts: body.contentParts } : {}),
        ...(body.attachments
          ? {
              attachments: body.attachments.map(attachment => ({
                sourcePath: attachment.path,
                name: attachment.name,
                mimeType: attachment.mimeType,
                ...(attachment.size !== undefined ? { size: attachment.size } : {}),
                ...(attachment.mtime !== undefined ? { mtime: attachment.mtime } : {}),
              })),
            }
          : {}),
        ...(body.providerId ? { providerId: body.providerId } : {}),
        ...(body.modelId ? { modelId: body.modelId } : {}),
        ...(body.thinkingEnabled !== undefined ? { thinkingEnabled: body.thinkingEnabled } : {}),
        ...(body.kbId ? { kbId: body.kbId } : {}),
        ...(body.kbAssetIds ? { kbAssetIds: body.kbAssetIds } : {}),
      });
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return context.json({ error: 'session_busy', message: error.message }, 409);
      }
      throw error;
    }

    // 先挂扇出（登记空重放槽）再返回身份，避免客户端立即订阅时首事件尚未到达。
    deps.fanout.attach(handle, { ttsEnabled: body.ttsEnabled ?? false });
    return context.json({ turnId: handle.turnId, sessionId: handle.sessionId });
  });

  return app;
}
