import { Hono } from 'hono';
import { z } from 'zod';
import { ModelBindingsRepo } from '@ema-agent/storage';
import type { BindingModule } from '@ema-agent/storage';
import type { AppBindings } from '../wiring.js';
import { configureBridge } from '../wiring.js';

// Keep in sync with BindingModule and migration CHECK constraints.
const BINDING_MODULES = [
  // TS-side LLM modules
  'chat', 'narrative', 'agent',
  'compaction', 'emotion',
  'router', 'plan-parse', 'title',
  // LightRAG internal config — changes here trigger bridge re-push
  'embed', 'rerank', 'lightrag-llm',
  // Future TS-side clients (reserved, not bridge)
  'tts', 'stt', 'vision', 'imagegen',
] as const;

// Modules whose changes must be pushed to the Python bridge (LightRAG config).
const BRIDGE_MODULES = new Set<string>(['embed', 'rerank', 'lightrag-llm']);

const moduleSchema = z.enum(BINDING_MODULES);

const upsertSchema = z.object({
  providerConfigId: z.string(),
  model:            z.string(),
  voiceId:          z.string().optional(),
  config:           z.record(z.unknown()).default({}),
});

export function modelBindingsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // GET /api/model-bindings
  app.get('/', (c) => {
    const repo = new ModelBindingsRepo(bindings.db.sqlite);
    return c.json(repo.list());
  });

  // PUT /api/model-bindings/:module
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
    const repo = new ModelBindingsRepo(bindings.db.sqlite);

    repo.upsert({
      module,
      providerConfigId: bodyParsed.data.providerConfigId,
      model:            bodyParsed.data.model,
      voiceId:          bodyParsed.data.voiceId,
      config:           bodyParsed.data.config,
    });

    // Bridge only cares about its three internal config modules.
    if (BRIDGE_MODULES.has(module)) {
      void configureBridge(bindings.db, bindings.retrieval);
    }

    return c.json(repo.get(module));
  });

  // DELETE /api/model-bindings/:module
  app.delete('/:module', (c) => {
    const moduleParsed = moduleSchema.safeParse(c.req.param('module'));
    if (!moduleParsed.success) {
      return c.json({ error: 'invalid_module', validModules: BINDING_MODULES }, 400);
    }

    const module = moduleParsed.data as BindingModule;
    const repo = new ModelBindingsRepo(bindings.db.sqlite);
    repo.delete(module);

    if (BRIDGE_MODULES.has(module)) {
      void configureBridge(bindings.db, bindings.retrieval);
    }

    return c.body(null, 204);
  });

  return app;
}
