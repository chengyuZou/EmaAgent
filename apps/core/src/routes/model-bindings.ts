import { Hono } from 'hono';
import { z } from 'zod';
import { ModelBindingsRepo } from '@ema-agent/storage';
import type { BindingModule } from '@ema-agent/storage';
import type { AppBindings } from '../wiring.js';
import { configureBridge } from '../wiring.js';
import { reloadTtsClient } from '../wiring/tts.js';
import { reloadSttClient } from '../wiring/stt.js';

// Keep in sync with BindingModule type and migration 001 CHECK constraint.
const BINDING_MODULES = [
  // TS-side LLM modules
  'chat', 'narrative', 'agent',
  'compaction', 'emotion', 'memory',
  'router', 'plan-parse', 'title',
  // LightRAG internal config — changes here trigger bridge re-push
  'embed', 'rerank', 'lightrag-llm',
  // TTS — per-mode, voice identity always from character card
  'tts_chat', 'tts_narrative', 'tts_agent',
  // Other TS-side clients (reserved)
  'stt', 'vision', 'imagegen',
] as const;

// Modules whose changes must be pushed to the Python bridge (LightRAG config).
const BRIDGE_MODULES = new Set<string>(['embed', 'lightrag-llm']);

// Modules whose changes must trigger TtsClient / SttClient hot-reload.
const TTS_MODULES = new Set<string>(['tts_chat', 'tts_narrative', 'tts_agent']);
const STT_MODULES = new Set<string>(['stt']);

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
    const repo = new ModelBindingsRepo(bindings.profileDb.sqlite);
    return c.json(repo.list());
  });

  // GET /api/model-bindings/:module — list bindings for one module
  app.get('/:module', (c) => {
    const moduleParsed = moduleSchema.safeParse(c.req.param('module'));
    if (!moduleParsed.success) {
      return c.json({ error: 'invalid_module', validModules: BINDING_MODULES }, 400);
    }
    const module = moduleParsed.data as BindingModule;
    const repo = new ModelBindingsRepo(bindings.profileDb.sqlite);
    return c.json(repo.listByModule(module));
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
    const repo = new ModelBindingsRepo(bindings.profileDb.sqlite);

    repo.upsert({
      module,
      providerConfigId: bodyParsed.data.providerConfigId,
      model:            bodyParsed.data.model,
      voiceId:          bodyParsed.data.voiceId,
      config:           bodyParsed.data.config,
    });

    // Bridge only cares about its two internal config modules.
    if (BRIDGE_MODULES.has(module)) {
      void configureBridge(bindings.profileDb, bindings.narrative);
    }
    if (TTS_MODULES.has(module)) reloadTtsClient(bindings.tts, bindings.profileDb);
    if (STT_MODULES.has(module)) reloadSttClient(bindings.stt, bindings.profileDb);

    // Return the updated list for this module
    return c.json(repo.listByModule(module));
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
    const repo = new ModelBindingsRepo(bindings.profileDb.sqlite);
    repo.delete(module, queryParsed.data.providerConfigId, queryParsed.data.model);

    if (BRIDGE_MODULES.has(module)) {
      void configureBridge(bindings.profileDb, bindings.narrative);
    }
    if (TTS_MODULES.has(module)) reloadTtsClient(bindings.tts, bindings.profileDb);
    if (STT_MODULES.has(module)) reloadSttClient(bindings.stt, bindings.profileDb);

    return c.body(null, 204);
  });

  return app;
}
