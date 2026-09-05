// POST /api/turns：解析传输请求、定位或创建 Session、启动 Turn 并挂事件扇出。
import { Hono } from 'hono';
import { z } from 'zod';
import { SessionBusyError, type SessionStore } from '@ema-agent/session';
import {
  hasTurnInput,
  type TurnExecutor,
  type TurnInputPart,
} from '@ema-agent/turn';
import { REQUEST_VALUE_LIMITS } from '../../platform/requestBudget.js';
import type { TurnFanout } from '../../sse/turnFanout.js';
import { jsonBody } from '../validate.js';

const attachmentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('image_reference'),
    path: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('pasted_text_reference'),
    path: z.string().min(1),
    preview: z.string(),
  }),
  z.object({
    type: z.literal('file_reference'),
    path: z.string().min(1),
  }),
]);

const inputPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().max(REQUEST_VALUE_LIMITS.maxTurnTextChars),
  }),
  z.object({
    type: z.literal('attachment'),
    block: attachmentBlockSchema,
  }),
  z.object({ type: z.literal('skill_reference'), name: z.string().min(1), path: z.string().min(1) }),
]);

const startTurnBody = z.object({
  sessionId: z.string().min(1).optional(),
  executionProfile: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
  input: z.array(inputPartSchema).min(1).max(REQUEST_VALUE_LIMITS.maxTurnContentParts),
  modelSelection: z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: z.enum(['low', 'medium', 'high', 'max']),
  }).optional(),
  knowledge: z.object({
    assetIds: z.array(z.string().min(1))
      .min(1)
      .max(REQUEST_VALUE_LIMITS.maxTurnKbAssetScopes),
  }).optional(),
  ttsEnabled: z.boolean().optional(),
}).superRefine((body, context) => {
  const attachmentCount = body.input.filter(part => part.type === 'attachment').length;
  if (attachmentCount > REQUEST_VALUE_LIMITS.maxTurnAttachments) {
    context.addIssue({ code: 'custom', path: ['input'], message: '附件数量超过单次 Turn 上限' });
  }
  const skillCount = body.input.filter(part => part.type === 'skill_reference').length;
  if (skillCount > 8) {
    context.addIssue({ code: 'custom', path: ['input'], message: 'Skill 数量超过单次 Turn 上限' });
  }
});

export interface StartTurnRouteDeps {
  readonly executor: TurnExecutor;
  readonly fanout: TurnFanout;
  readonly session: Pick<SessionStore, 'createSession' | 'sessionExists'>;
}

export const startTurnRoute = (deps: StartTurnRouteDeps) =>
  new Hono()
    .post('/', jsonBody(startTurnBody), async context => {
    const body = context.req.valid('json');
    const input: TurnInputPart[] = body.input;
    if (!hasTurnInput(input)) {
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
        input,
        ...(body.modelSelection ? { modelSelection: body.modelSelection } : {}),
        ...(body.knowledge ? { knowledge: body.knowledge } : {}),
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
