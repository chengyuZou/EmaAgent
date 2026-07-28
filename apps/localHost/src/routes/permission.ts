// 提供权限审批响应和永久规则管理的 HTTP 边界。
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PermissionResponse, PermissionRule } from '@ema-agent/permission';
import { asTurnId } from '@ema-agent/ids';
import { filterPermissionPending } from '@ema-agent/turn';
import type { AppBindings } from '../wiring/index.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const respondSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }),
  z.object({ action: z.literal('allow_session') }),
  z.object({
    action: z.literal('deny'),
    reason: z.string().optional(),
  }),
]);

const permissionRuleSchema = z.object({
  action: z.enum(['allow', 'deny', 'ask']),
  tool: z.string().trim().min(1).max(128),
  pathGlob: z.string().trim().min(1).max(2048).optional(),
  scope: z.enum(['global', 'workspace']),
  workspaceRoot: z.string().trim().min(1).max(4096).optional(),
}).superRefine((rule, context) => {
  if (rule.scope === 'workspace' && !rule.workspaceRoot) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspaceRoot'],
      message: 'workspace scope requires workspaceRoot',
    });
  }
  if (rule.scope === 'workspace' && rule.workspaceRoot && !path.isAbsolute(rule.workspaceRoot)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspaceRoot'],
      message: 'workspaceRoot must be an absolute path',
    });
  }
});

const setRuleEnabledSchema = z.object({ enabled: z.boolean() });

// ── Route factory ────────────────────────────────────────────────────────────

/**
 * 前端 Permission 审批入口。
 *
 * respond 用 PermissionResponse 解决等待中的审批；
 * cancel 以明确拒绝终态关闭审批；
 * pending 返回窗口重开后可恢复的在飞快照。
 */
export function permissionRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  app.get('/rules', (c) => c.json({ rules: bindings.permission.getRules() }));

  app.post('/rules', async (c) => {
    const parsed = permissionRuleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const input: PermissionRule = parsed.data.scope === 'global'
      ? { ...parsed.data, workspaceRoot: undefined }
      : { ...parsed.data, workspaceRoot: path.resolve(parsed.data.workspaceRoot!) };
    return c.json({ rule: bindings.permission.addRule(input) }, 201);
  });

  app.patch('/rules/:ruleId', async (c) => {
    const ruleId = c.req.param('ruleId');
    const parsed = setRuleEnabledSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    if (!bindings.permission.getRules().some((rule) => rule.id === ruleId)) {
      return c.json({ error: 'not_found', ruleId }, 404);
    }
    bindings.permission.setRuleEnabled(ruleId, parsed.data.enabled);
    return c.json({ ok: true });
  });

  app.delete('/rules/:ruleId', (c) => {
    const ruleId = c.req.param('ruleId');
    if (!bindings.permission.removeRule(ruleId)) {
      return c.json({ error: 'not_found', ruleId }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/:turnId/:promptId/respond', async (c) => {
    const turnId = asTurnId(c.req.param('turnId'));
    const promptId = c.req.param('promptId');
    const parsed = respondSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const response = parsed.data as PermissionResponse;
    const ok = bindings.interactionQueue.respondPermission(promptId, response, turnId);
    if (!ok) {
      return c.json({ error: 'not_found_or_expired', promptId }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/:turnId/:promptId/cancel', (c) => {
    const turnId = asTurnId(c.req.param('turnId'));
    const promptId = c.req.param('promptId');
    const ok = bindings.interactionQueue.cancelPermission(
      promptId,
      'cancelled by user',
      turnId,
    );
    if (!ok) {
      return c.json({ error: 'not_found_or_expired', promptId }, 404);
    }
    return c.json({ ok: true });
  });

  app.get('/pending', (c) => {
    // 统一队列混合快照按 kind 过滤出 Permission 部分。
    const prompts = filterPermissionPending(bindings.interactionQueue.listPending());
    return c.json({ count: prompts.length, prompts });
  });

  return app;
}
