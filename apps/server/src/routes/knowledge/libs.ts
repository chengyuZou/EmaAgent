// 知识库注册表管理：列表(含计数摘要)、创建、改名、激活与注销；库级模型配置跟随库。
// 激活是纯注册表切换(不停任务);注销先停队列再关库并永久删除库目录,由 KbManager 保证。
import { Hono } from 'hono';
import { z } from 'zod';
import { KnowledgeInvalidRequestError, type KbManager } from '@ema-agent/knowledge';
import type { ProviderModels } from '@ema-agent/providers';
import { knowledgeError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface KnowledgeLibsRouteDeps {
  readonly kb: Pick<
    KbManager,
    'listKbSummaries' | 'getKb' | 'createKb' | 'renameKb' | 'setActiveKb' | 'unregisterKb' | 'setEmbed' | 'setRerank'
  >;
  readonly providerModels: Pick<ProviderModels, 'get'>;
}

const createBody = z.object({
  name: z.string().min(1).max(100),
  /** 父目录;库目录 = <path>/<随机 id> 由服务端自建。 */
  path: z.string().min(1),
});

const renameBody = z.object({
  name: z.string().min(1).max(100),
});

const modelRef = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

/** 部分更新:出现的字段才写;null 清除。 */
const modelsBody = z.object({
  embed: modelRef.nullable().optional(),
  rerank: modelRef.nullable().optional(),
});

export const knowledgeLibsRoute = (deps: KnowledgeLibsRouteDeps) =>
  new Hono()
    .get('/libs', context => {
      return context.json({ items: deps.kb.listKbSummaries() });
    })
    .post('/libs', jsonBody(createBody), async context => {
      const { name, path } = context.req.valid('json');
      try {
        return context.json(await deps.kb.createKb(name, path), 201);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .patch('/libs/:id', jsonBody(renameBody), async context => {
      if (!deps.kb.getKb(context.req.param('id'))) {
        return context.json({ error: 'kb_not_found' }, 404);
      }
      deps.kb.renameKb(context.req.param('id'), context.req.valid('json').name);
      return context.json({ ok: true });
    })
    .post('/libs/:id/activate', context => {
      if (!deps.kb.setActiveKb(context.req.param('id'))) {
        return context.json({ error: 'kb_not_found' }, 404);
      }
      return context.json({ ok: true });
    })
    // 库级 Embedding/Rerank 配置: 部分更新,出现的字段才写;引用必须指向已启用的对应能力模型行。
    .patch('/libs/:id/models', jsonBody(modelsBody), async context => {
      const id = context.req.param('id');
      if (!deps.kb.getKb(id)) {
        return context.json({ error: 'kb_not_found' }, 404);
      }
      const body = context.req.valid('json');
      try {
        if (body.embed !== undefined) {
          assertModelRef(deps.providerModels, 'embed', body.embed);
          await deps.kb.setEmbed(id, body.embed);
        }
        if (body.rerank !== undefined) {
          assertModelRef(deps.providerModels, 'rerank', body.rerank);
          await deps.kb.setRerank(id, body.rerank);
        }
        return context.json(deps.kb.getKb(id));
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .delete('/libs/:id', async context => {
      if (!deps.kb.getKb(context.req.param('id'))) {
        return context.json({ error: 'kb_not_found' }, 404);
      }
      await deps.kb.unregisterKb(context.req.param('id'));
      return context.json({ ok: true });
    });

function assertModelRef(
  models: Pick<ProviderModels, 'get'>,
  capability: 'embed' | 'rerank',
  ref: { providerId: string; modelId: string } | null,
): void {
  if (ref === null) return;
  const model = models.get(ref.providerId, capability, ref.modelId);
  if (!model || model.capability !== capability || !model.enabled) {
    throw new KnowledgeInvalidRequestError(
      `模型不可用或能力不符: ${ref.providerId}/${ref.modelId} (${capability})`,
    );
  }
}
