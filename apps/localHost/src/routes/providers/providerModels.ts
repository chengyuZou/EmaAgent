// 暴露各 Provider 的可用模型目录和启用池，并在禁用模型时清理失效绑定。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { EmbedRuntime } from '@ema-agent/embed';
import {
  modelsDevIdFor,
  providerCatalog,
  staticModelsFor,
  type ModelBindingControl,
  type ModelCapabilityResolver,
  type ModelsDevCatalog,
} from '@ema-agent/provider';
import type {
  ProviderConfigRow,
  ProviderEmbedModelsRepo,
  ProviderLlmModelsRepo,
  ProviderRerankModelsRepo,
  ProvidersRepo,
  ProviderSttModelsRepo,
  ProviderTtsModelsRepo,
  ProviderVisionModelsRepo,
} from '@ema-agent/storage';

const enableLlmModelSchema = z.object({
  contextWindow: z.number().int().positive(),
  contextSource: z.enum(['live', 'table', 'manual']).optional(),
}).strict();

const enableEmbedModelSchema = z.object({
  dim: z.number().int().positive().optional(),
  dimSource: z.enum(['live', 'table', 'manual']).optional(),
}).strict();

const enableRerankModelSchema = z.object({
  maxChunks: z.number().int().positive().optional(),
}).strict();

export interface ProviderModelsRouteDependencies {
  providers: Pick<ProvidersRepo, 'get'>;
  modelBindings: Pick<ModelBindingControl, 'deleteByProviderModel'>;
  llmModels: ProviderLlmModelsRepo;
  embedModels: ProviderEmbedModelsRepo;
  rerankModels: ProviderRerankModelsRepo;
  ttsModels: ProviderTtsModelsRepo;
  sttModels: ProviderSttModelsRepo;
  visionModels: ProviderVisionModelsRepo;
  modelCatalog: ModelsDevCatalog;
  modelCapabilities: ModelCapabilityResolver;
  embed: Pick<EmbedRuntime, 'embed'>;
  fetchLlmModels(
    provider: ProviderConfigRow,
    input: { modelsDevId?: string; modelCatalog: ModelsDevCatalog },
  ): Promise<{ models: string[]; source: string }>;
  fetchEmbedModels(
    provider: ProviderConfigRow,
  ): Promise<{ models: string[]; source: string }>;
  fetchVisionModels(
    provider: ProviderConfigRow,
    input: { modelsDevId?: string; modelCatalog: ModelsDevCatalog },
  ): Promise<{ models: string[]; source: string }>;
}

export function providerModelsRoute(
  dependencies: ProviderModelsRouteDependencies,
): Hono {
  const app = new Hono();

  app.get('/models', (c) => {
    const rows = dependencies.llmModels.listAllWithProvider();
    return c.json(rows.map((row) => ({
      providerId: row.provider_config_id,
      providerName: row.display_name,
      model: row.model,
      contextWindow: row.context_window,
      contextSource: row.context_source,
      definitionId: row.definition_id,
      reasoning: dependencies.modelCapabilities.resolve({
        providerId: row.provider_config_id,
        model: row.model,
      }).reasoning === 'supported',
    })));
  });

  registerLlmModelRoutes(app, dependencies);
  registerEmbedModelRoutes(app, dependencies);
  registerRerankModelRoutes(app, dependencies);
  registerSimpleModelRoutes(app, dependencies, 'tts');
  registerSimpleModelRoutes(app, dependencies, 'stt');
  registerVisionModelRoutes(app, dependencies);
  return app;
}

function registerLlmModelRoutes(
  app: Hono,
  dependencies: ProviderModelsRouteDependencies,
): void {
  app.get('/:id/models', async (c) => {
    const provider = dependencies.providers.get(c.req.param('id')!);
    if (!provider) return c.json({ error: 'not_found' }, 404);

    const definition = providerCatalog.get(provider.definition_id);
    const modelsDevId = definition
      ? modelsDevIdFor(definition, 'llm')
      : undefined;
    const { models, source } = await dependencies.fetchLlmModels(provider, {
      modelsDevId,
      modelCatalog: dependencies.modelCatalog,
    });
    const enabled = new Map(
      dependencies.llmModels
        .listByProvider(provider.id)
        .map((model) => [model.model, model.context_window]),
    );

    return c.json({
      source,
      models: models.map((model) => ({
        id: model,
        contextWindow: enabled.get(model)
          ?? (modelsDevId
            ? dependencies.modelCatalog.get(modelsDevId, model)?.contextWindow
            : undefined)
          ?? null,
        enabled: enabled.has(model),
      })),
    });
  });

  app.put('/:id/models/:model', async (c) => {
    const body = enableLlmModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const providerId = c.req.param('id')!;
    if (!dependencies.providers.get(providerId)) {
      return c.json({ error: 'not_found' }, 404);
    }
    dependencies.llmModels.upsert({
      providerConfigId: providerId,
      model: decodeURIComponent(c.req.param('model')),
      contextWindow: body.data.contextWindow,
      contextSource: body.data.contextSource,
    });
    return c.body(null, 204);
  });

  app.delete('/:id/models/:model', (c) => {
    return removeModel(
      c,
      dependencies.llmModels,
      dependencies.modelBindings,
    );
  });
}

function registerEmbedModelRoutes(
  app: Hono,
  dependencies: ProviderModelsRouteDependencies,
): void {
  app.get('/:id/embed-models', async (c) => {
    const provider = dependencies.providers.get(c.req.param('id')!);
    if (!provider) return c.json({ error: 'not_found' }, 404);
    const { models, source } = await dependencies.fetchEmbedModels(provider);
    const enabled = new Map(
      dependencies.embedModels
        .listByProvider(provider.id)
        .map((model) => [model.model, model.dim]),
    );
    return c.json({
      source,
      models: models.map((model) => ({
        id: model,
        dim: enabled.get(model) ?? null,
        enabled: enabled.has(model),
      })),
    });
  });

  app.put('/:id/embed-models/:model', async (c) => {
    const body = enableEmbedModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const providerId = c.req.param('id')!;
    const model = decodeURIComponent(c.req.param('model'));
    if (!dependencies.providers.get(providerId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    let dim = body.data.dim;
    let dimSource: 'live' | 'table' | 'manual' = body.data.dimSource ?? 'manual';
    try {
      const result = await dependencies.embed.embed({
        providerId,
        model,
        texts: ['test'],
      });
      if (result.dim > 0) {
        dim = result.dim;
        dimSource = 'live';
      }
    } catch {
      // 离线时允许使用用户明确填写的维度，但绝不猜测向量空间。
    }

    if (!dim || dim <= 0) {
      return c.json({
        error: 'dim_unknown',
        message: '无法探测 Embedding 维度，请手动填写 dim。',
      }, 422);
    }
    dependencies.embedModels.upsert({
      providerConfigId: providerId,
      model,
      dim,
      dimSource,
    });
    return c.body(null, 204);
  });

  app.delete('/:id/embed-models/:model', (c) => {
    return removeModel(
      c,
      dependencies.embedModels,
      dependencies.modelBindings,
    );
  });
}

function registerRerankModelRoutes(
  app: Hono,
  dependencies: ProviderModelsRouteDependencies,
): void {
  app.get('/:id/rerank-models', (c) => {
    const provider = dependencies.providers.get(c.req.param('id'));
    if (!provider) return c.json({ error: 'not_found' }, 404);
    const definition = providerCatalog.get(provider.definition_id);
    const models = definition ? staticModelsFor(definition, 'rerank') : [];
    const enabled = new Map(
      dependencies.rerankModels
        .listByProvider(provider.id)
        .map((model) => [model.model, model.max_chunks]),
    );
    return c.json({
      source: 'static',
      models: models.map((model) => ({
        id: model,
        maxChunks: enabled.get(model) ?? null,
        enabled: enabled.has(model),
      })),
    });
  });

  app.put('/:id/rerank-models/:model', async (c) => {
    const body = enableRerankModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const providerId = c.req.param('id');
    if (!dependencies.providers.get(providerId)) {
      return c.json({ error: 'not_found' }, 404);
    }
    dependencies.rerankModels.upsert({
      providerConfigId: providerId,
      model: decodeURIComponent(c.req.param('model')!),
      maxChunks: body.data.maxChunks,
    });
    return c.body(null, 204);
  });

  app.delete('/:id/rerank-models/:model', (c) => {
    return removeModel(
      c,
      dependencies.rerankModels,
      dependencies.modelBindings,
    );
  });
}

function registerSimpleModelRoutes(
  app: Hono,
  dependencies: ProviderModelsRouteDependencies,
  capability: 'tts' | 'stt',
): void {
  const path = `/:id/${capability}-models`;
  const pool = capability === 'tts'
    ? dependencies.ttsModels
    : dependencies.sttModels;

  app.get(path, (c) => {
    const provider = dependencies.providers.get(c.req.param('id')!);
    if (!provider) return c.json({ error: 'not_found' }, 404);
    const definition = providerCatalog.get(provider.definition_id);
    const models = definition ? staticModelsFor(definition, capability) : [];
    const enabled = new Set(
      pool.listByProvider(provider.id).map((model) => model.model),
    );
    return c.json({
      source: 'static',
      models: models.map((model) => ({ id: model, enabled: enabled.has(model) })),
    });
  });

  app.put(`${path}/:model`, (c) => {
    const providerId = c.req.param('id')!;
    if (!dependencies.providers.get(providerId)) {
      return c.json({ error: 'not_found' }, 404);
    }
    pool.upsert({
      providerConfigId: providerId,
      model: decodeURIComponent(c.req.param('model')!),
    });
    return c.body(null, 204);
  });

  app.delete(`${path}/:model`, (c) => {
    return removeModel(c, pool, dependencies.modelBindings);
  });
}

function registerVisionModelRoutes(
  app: Hono,
  dependencies: ProviderModelsRouteDependencies,
): void {
  app.get('/:id/vision-models', async (c) => {
    const provider = dependencies.providers.get(c.req.param('id'));
    if (!provider) return c.json({ error: 'not_found' }, 404);
    const definition = providerCatalog.get(provider.definition_id);
    const { models, source } = await dependencies.fetchVisionModels(provider, {
      modelsDevId: definition
        ? modelsDevIdFor(definition, 'vision')
        : undefined,
      modelCatalog: dependencies.modelCatalog,
    });
    const enabled = new Set(
      dependencies.visionModels
        .listByProvider(provider.id)
        .map((model) => model.model),
    );
    return c.json({
      source,
      models: models.map((model) => ({ id: model, enabled: enabled.has(model) })),
    });
  });

  app.put('/:id/vision-models/:model', (c) => {
    const providerId = c.req.param('id');
    if (!dependencies.providers.get(providerId)) {
      return c.json({ error: 'not_found' }, 404);
    }
    dependencies.visionModels.upsert({
      providerConfigId: providerId,
      model: decodeURIComponent(c.req.param('model')),
    });
    return c.body(null, 204);
  });

  app.delete('/:id/vision-models/:model', (c) => {
    return removeModel(
      c,
      dependencies.visionModels,
      dependencies.modelBindings,
    );
  });
}

interface RemovableModelPool {
  remove(providerConfigId: string, model: string): boolean;
}

interface ModelBindingCleaner {
  deleteByProviderModel(providerConfigId: string, model: string): number;
}

function removeModel(
  c: Context,
  pool: RemovableModelPool,
  bindings: ModelBindingCleaner,
) {
  const providerId = c.req.param('id')!;
  const model = decodeURIComponent(c.req.param('model')!);
  if (!pool.remove(providerId, model)) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({
    ok: true,
    cascadedBindings: bindings.deleteByProviderModel(providerId, model),
  });
}
