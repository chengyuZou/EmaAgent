import { Hono } from 'hono';
import { z } from 'zod';
import type { BindingModule } from '@ema-agent/storage';
import type { AppBindings } from '../wiring/index.js';

// Keep in sync with BindingModule type and migration 005 CHECK constraint.
const BINDING_MODULES = [
  // TS-side LLM modules. (chat/narrative/agent/compaction retired — those模式
  // pick their model in the chat UI, and compaction reuses the turn's model.)
  'emotion', 'memory',
  'router', 'plan-parse', 'title',
  // LightRAG internal config — changes here trigger bridge re-push.
  // KB embed/rerank moved OUT to app settings (kb.models); only LightRAG's
  // dedicated embed remains a binding. lightrag-embed = bge-m3 (don't casually change).
  'lightrag-embed', 'lightrag-llm',
  // TTS — SINGLE binding for all modes (voice identity always from the
  // character card). Must match the model_bindings CHECK constraint and the
  // orchestrator's modelBindings.get('tts') — an earlier per-mode design
  // (tts_chat/narrative/agent) was never reflected in the DB or orchestrator
  // and made every TTS save fail with invalid_module.
  'tts',
  // Other TS-side clients (reserved)
  'stt', 'vision', 'imagegen',
] as const;

// Modules whose changes must be pushed to the Python bridge (LightRAG config).
const BRIDGE_MODULES = new Set<string>(['lightrag-embed', 'lightrag-llm']);

const moduleSchema = z.enum(BINDING_MODULES);

const upsertSchema = z.object({
  providerConfigId: z.string(),
  model:            z.string(),
  voiceId:          z.string().optional(),
  config:           z.record(z.unknown()).default({}),
});

const deleteQuerySchema = z.object({
  providerConfigId: z.string(),
  model:            z.string(),
});

export function modelBindingsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // GET /api/model-bindings — list all bindings across all modules
  app.get('/', (c) => {
    return c.json(bindings.modelBindings.list());
  });

  // GET /api/model-bindings/available/:capability — the enabled-model pool the
  // binding picker draws from. Dispatches to the right per-capability pool repo.
  app.get('/available/:capability', (c) => {
    const capability = c.req.param('capability');
    const providers  = bindings.providers;
    const nameCache  = new Map<string, string>();

    const resolveName = (pcId: string): string => {
      let n = nameCache.get(pcId);
      if (n === undefined) {
        n = providers.get(pcId)?.display_name ?? pcId;
        nameCache.set(pcId, n);
      }
      return n;
    };

    switch (capability) {
      case 'llm': {
        const rows = bindings.providerLlmModels.listAll();
        return c.json({
          models: rows.map((r) => ({
            providerConfigId: r.provider_config_id,
            providerName:     resolveName(r.provider_config_id),
            model:            r.model,
            contextWindow:    r.context_window,
          })),
        });
      }
      case 'embed': {
        const rows = bindings.providerEmbedModels.listAll();
        return c.json({
          models: rows.map((r) => ({
            providerConfigId: r.provider_config_id,
            providerName:     resolveName(r.provider_config_id),
            model:            r.model,
            contextWindow:    0,
            dim:              r.dim,
          })),
        });
      }
      case 'rerank': {
        const rows = bindings.providerRerankModels.listAll();
        return c.json({
          models: rows.map((r) => ({
            providerConfigId: r.provider_config_id,
            providerName:     resolveName(r.provider_config_id),
            model:            r.model,
            contextWindow:    0,
            maxChunks:        r.max_chunks ?? 0,
          })),
        });
      }
      case 'tts': {
        const rows = bindings.providerTtsModels.listAll();
        return c.json({
          models: rows.map((r) => ({
            providerConfigId: r.provider_config_id,
            providerName:     resolveName(r.provider_config_id),
            model:            r.model,
            contextWindow:    0,
          })),
        });
      }
      case 'stt': {
        const rows = bindings.providerSttModels.listAll();
        return c.json({
          models: rows.map((r) => ({
            providerConfigId: r.provider_config_id,
            providerName:     resolveName(r.provider_config_id),
            model:            r.model,
            contextWindow:    0,
          })),
        });
      }
      case 'vision': {
        const rows = bindings.providerVisionModels.listAll();
        return c.json({
          models: rows.map((r) => ({
            providerConfigId: r.provider_config_id,
            providerName:     resolveName(r.provider_config_id),
            model:            r.model,
            contextWindow:    0,
          })),
        });
      }
      default:
        return c.json({ models: [] });
    }
  });

  // GET /api/model-bindings/:module — list bindings for one module
  app.get('/:module', (c) => {
    const moduleParsed = moduleSchema.safeParse(c.req.param('module'));
    if (!moduleParsed.success) {
      return c.json({ error: 'invalid_module', validModules: BINDING_MODULES }, 400);
    }
    const module = moduleParsed.data as BindingModule;
    return c.json(bindings.modelBindings.listByModule(module));
  });

  // PUT /api/model-bindings/:module/set — atomic single-select: delete all
  // existing bindings for the module, then upsert the one given model.
  app.put('/:module/set', async (c) => {
    const moduleParsed = moduleSchema.safeParse(c.req.param('module'));
    if (!moduleParsed.success) {
      return c.json({ error: 'invalid_module', validModules: BINDING_MODULES }, 400);
    }

    const bodyParsed = upsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!bodyParsed.success) {
      return c.json({ error: 'invalid_request', details: bodyParsed.error.flatten() }, 400);
    }

    const module = moduleParsed.data as BindingModule;

    // Atomic: wipe old → insert new (single-select semantics)
    bindings.modelBindings.setSingle({
      module,
      providerConfigId: bodyParsed.data.providerConfigId,
      model:            bodyParsed.data.model,
      voiceId:          bodyParsed.data.voiceId,
      config:           bodyParsed.data.config,
    });

    if (BRIDGE_MODULES.has(module)) {
      void bindings.providerRuntime.syncBridge();
    }

    return c.json(bindings.modelBindings.listByModule(module));
  });

  // PUT /api/model-bindings/:module — upsert one binding
  app.put('/:module', async (c) => {
    const moduleParsed = moduleSchema.safeParse(c.req.param('module'));
    if (!moduleParsed.success) {
      return c.json({ error: 'invalid_module', validModules: BINDING_MODULES }, 400);
    }

    const bodyParsed = upsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!bodyParsed.success) {
      return c.json({ error: 'invalid_request', details: bodyParsed.error.flatten() }, 400);
    }

    const module = moduleParsed.data as BindingModule;

    bindings.modelBindings.upsert({
      module,
      providerConfigId: bodyParsed.data.providerConfigId,
      model:            bodyParsed.data.model,
      voiceId:          bodyParsed.data.voiceId,
      config:           bodyParsed.data.config,
    });

    // Bridge only cares about its two internal config modules.
    if (BRIDGE_MODULES.has(module)) {
      void bindings.providerRuntime.syncBridge();
    }

    // Return the updated list for this module
    return c.json(bindings.modelBindings.listByModule(module));
  });

  // DELETE /api/model-bindings/:module?providerConfigId=...&model=...
  app.delete('/:module', (c) => {
    const moduleParsed = moduleSchema.safeParse(c.req.param('module'));
    if (!moduleParsed.success) {
      return c.json({ error: 'invalid_module', validModules: BINDING_MODULES }, 400);
    }

    const queryParsed = deleteQuerySchema.safeParse(c.req.query());
    if (!queryParsed.success) {
      return c.json({ error: 'invalid_request', details: queryParsed.error.flatten() }, 400);
    }

    const module = moduleParsed.data as BindingModule;
    bindings.modelBindings.delete(module, queryParsed.data.providerConfigId, queryParsed.data.model);

    if (BRIDGE_MODULES.has(module)) {
      void bindings.providerRuntime.syncBridge();
    }

    return c.body(null, 204);
  });

  return app;
}
