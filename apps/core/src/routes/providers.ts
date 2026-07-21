import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type {
  BindingModule,
  ProviderConfigRow,
  ProviderHealthRow,
} from '@ema-agent/storage';
import {
  listProviderCapabilities,
  modelsDevIdFor,
  PROTOCOL_FAMILIES,
  providerCatalog,
  PROVIDER_CONFIG_LIMITS,
  staticModelsFor,
  type ProviderDefinition,
  type Capability,
} from '@ema-agent/provider';
import type { AppBindings } from '../wiring/index.js';
import {
  fetchLlmModels,
  fetchEmbedModels,
} from '../wiring/index.js';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/providers/tts.js';
import { fetchVisionModels } from '../wiring/providers/vision.js';
import {
  providerCredentialOperationSchema,
  registerProviderCredentialRoutes,
  resolveProviderCredential,
} from './provider-credential.js';
import { REQUEST_VALUE_LIMITS } from '../http/request-budget.js';
import {
  capabilityInputsFromProviderRow,
  validateProviderCapabilityConfigs,
} from './provider-capability-config.js';

// ── Response shaping ──────────────────────────────────────────────────────────

function shapeProvider(
  config: ProviderConfigRow,
  health: ProviderHealthRow | null,
  def: ProviderDefinition | undefined,
) {
  return {
    id:           config.id,
    definitionId: config.definition_id,
    displayName:  config.display_name,
    hasApiKey:    !!config.credential,
    enabled:      config.enabled === 1,
    capabilities: config.capabilities.map((capability) => ({
      capability: capability.capability,
      protocol: capability.protocol,
      baseUrl: capability.base_url,
      embeddingRevision: capability.embedding_revision,
      enabled: capability.enabled === 1,
    })),
    health: health ? {
      status:       health.status,
      latencyMs:    health.latency_ms,
      lastError:    health.last_error,
      lastProbedAt: health.last_probed_at,
    } : null,
    definition: def ?? null,
  };
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const capabilityConfigSchema = z.object({
  capability: z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']),
  protocol: z.enum(PROTOCOL_FAMILIES).optional().nullable(),
  baseUrl: z.string().max(PROVIDER_CONFIG_LIMITS.baseUrlChars).optional().nullable(),
  embeddingRevision: z.string().max(256).optional().nullable(),
  enabled: z.boolean().optional(),
}).strict();

const createSchema = z.object({
  definitionId: z.string(),
  displayName:  z.string().optional(),
  apiKey:       z.string().max(PROVIDER_CONFIG_LIMITS.apiKeyChars).optional(),
  enabled:      z.boolean().default(true),
  capabilities: z.array(capabilityConfigSchema).optional(),
});

const patchSchema = z.object({
  displayName:  z.string().optional(),
  credential:   providerCredentialOperationSchema.optional(),
  enabled:      z.boolean().optional(),
  capability:   capabilityConfigSchema.optional(),
}).strict();

const enableModelSchema = z.object({
  contextWindow: z.number().int().positive(),
  contextSource: z.enum(['live', 'table', 'manual']).optional(),
});

const enableEmbedModelSchema = z.object({
  // Optional: the server probes the real dim (embed a short text) at enable time.
  // Only used as a fallback when the probe fails (offline / provider error).
  dim:       z.number().int().positive().optional(),
  dimSource: z.enum(['live', 'table', 'manual']).optional(),
});

const enableRerankModelSchema = z.object({
  maxChunks: z.number().int().positive().optional(),
});

const ttsTestSchema = z.object({
  text: z.string().max(REQUEST_VALUE_LIMITS.maxTtsTestTextChars).optional(),
  model: z.string().min(1),
});

const BINDING_CAPABILITIES: Partial<Record<BindingModule, Capability>> = {
  emotion: 'llm',
  memory: 'llm',
  router: 'llm',
  'plan-parse': 'llm',
  title: 'llm',
  'lightrag-llm': 'llm',
  'lightrag-embed': 'embed',
  tts: 'tts',
  stt: 'stt',
  vision: 'vision',
};

// ── Route factory ─────────────────────────────────────────────────────────────

export function providersRoute(bindings: AppBindings): Hono {
  const app = new Hono();
  registerProviderCredentialRoutes(app, bindings);

  // GET /api/providers/definitions  — full registry for the "Add Provider" picker
  app.get('/definitions', (c) => {
    const defs = providerCatalog.list();
    return c.json(defs);
  });

  // GET /api/providers/models  — all enabled LLM models across all providers.
  // Drives the frontend model picker (ChatInput dropdown). Returns (providerId,
  // providerName, model, contextWindow) so the user sees "OpenAI / gpt-4o".
  app.get('/models', (c) => {
    const rows = bindings.providerLlmModels.listAllWithProvider();
    const result = rows.map(r => ({
      providerId:      r.provider_config_id,
      providerName:    r.display_name,
      model:           r.model,
      contextWindow:   r.context_window,
      contextSource:   r.context_source,
      definitionId:    r.definition_id,
      reasoning:       bindings.modelCapabilities.resolve({
        providerId: r.provider_config_id,
        model: r.model,
      }).reasoning === 'supported',
    }));
    return c.json(result);
  });

  // GET /api/providers
  app.get('/', (c) => {
    const repo = bindings.providers;
    const rows = repo.listWithHealth();
    return c.json(rows.map(({ config, health }) =>
      shapeProvider(config, health, providerCatalog.get(config.definition_id)),
    ));
  });

  // POST /api/providers
  app.post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    const def = providerCatalog.get(body.definitionId);
    if (!def) {
      return c.json({ error: 'unknown_definition', definitionId: body.definitionId }, 422);
    }

    const requestedCapabilities = body.capabilities
      ?? listProviderCapabilities(def).map((capability) => ({ capability }));
    const validCapabilities = validateProviderCapabilityConfigs(def, requestedCapabilities);
    if (!validCapabilities.ok) {
      return c.json({ error: 'invalid_capability_config', message: validCapabilities.message }, 422);
    }

    const repo = bindings.providers;
    const id = randomUUID();
    repo.upsert({
      id,
      definitionId: body.definitionId,
      displayName:  body.displayName ?? def.name,
      apiKey:       body.apiKey,
      enabled:      body.enabled,
      capabilities: validCapabilities.value,
    });

    const row = repo.get(id)!;
    bindings.providerRuntime.refresh();

    return c.json(shapeProvider(row, null, def), 201);
  });

  // GET /api/providers/:id
  app.get('/:id', (c) => {
    const repo = bindings.providers;
    const result = repo.getWithHealth(c.req.param('id'));
    if (!result) return c.json({ error: 'not_found' }, 404);
    const { config, health } = result;
    return c.json(shapeProvider(config, health, providerCatalog.get(config.definition_id)));
  });

  // PATCH /api/providers/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;

    const existing = repo.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    const def = providerCatalog.get(existing.definition_id);
    const currentCapabilities = capabilityInputsFromProviderRow(existing);
    let nextCapabilities = currentCapabilities;
    if (body.capability !== undefined) {
      if (!def) return c.json({ error: 'unknown_definition' }, 422);
      const validated = validateProviderCapabilityConfigs(def, [body.capability]);
      if (!validated.ok) {
        return c.json({ error: 'invalid_capability_config', message: validated.message }, 422);
      }
      const incoming = validated.value[0]!;
      nextCapabilities = [
        ...currentCapabilities.filter((item) => item.capability !== incoming.capability),
        incoming,
      ];

      if (incoming.enabled === false) {
        const affectedBindings = bindings.modelBindings
          .listByProviderConfig(id)
          .filter((binding) => {
            const requiredCapability = BINDING_CAPABILITIES[binding.module];
            return requiredCapability === incoming.capability;
          });
        if (affectedBindings.length > 0) {
          return c.json({
            error: 'provider_capability_in_use',
            message: '请先将使用该能力的业务模块换绑或解绑',
            bindings: affectedBindings.map((binding) => ({
              module: binding.module,
              model: binding.model,
              capability: BINDING_CAPABILITIES[binding.module],
            })),
          }, 409);
        }
      }
    }

    repo.upsert({
      id,
      definitionId: existing.definition_id,
      displayName:  body.displayName ?? existing.display_name,
      apiKey:       resolveProviderCredential(existing.credential, body.credential),
      enabled:      body.enabled ?? existing.enabled === 1,
      capabilities: nextCapabilities,
    });

    const updated = repo.get(id)!;
    bindings.providerRuntime.refresh();

    return c.json(shapeProvider(updated, repo.getHealth(id) ?? null, def));
  });

  // DELETE /api/providers/:id
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;

    const existing = repo.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const bindingsInUse = bindings.modelBindings.listByProviderConfig(id);
    if (bindingsInUse.length > 0) {
      return c.json({
        error: 'provider_in_use',
        message: '请先将使用该 Provider 的业务模块换绑或解绑',
        bindings: bindingsInUse.map((binding) => ({
          module: binding.module,
          model: binding.model,
        })),
      }, 409);
    }

    repo.delete(id);
    bindings.providerRuntime.refresh();

    return c.body(null, 204);
  });

  // ── Probe endpoints ────────────────────────────────────────────────────────
  //
  // One endpoint per capability. The old single `POST /:id/probe` dispatched by
  // capabilities-array order, so probing a multi-capability provider (e.g. OpenAI)
  // from the Embed section hit `capabilities.includes('llm')` first and probed
  // LLM instead of embed. Per-capability endpoints make the intent explicit in
  // the URL; each validates the provider supports that capability, picks a model
  // (when the probe needs one), and records health.
  //
  // llm/vision/embed/rerank probes test a specific model's availability; the
  // model is caller's choice → an enabled model → a catalog/default fallback.
  // tts/stt probes test provider connectivity only (adapter.probe() hits
  // /v1/models or equivalent — no synthesis), so no model is needed.

  const probeModelSchema = z.object({ model: z.string().optional() });

  function requireProvider(c: Context, id: string): ProviderConfigRow | Response {
    const existing = bindings.providers.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);
    return existing;
  }

  function requireCapability(c: Context, id: string, cap: Capability) {
    const existing = requireProvider(c, id);
    if (existing instanceof Response) return existing;
    const capability = existing.capabilities.find(
      (item) => item.capability === cap && item.enabled === 1,
    );
    if (!capability) return c.json({ error: 'capability_not_supported', capability: cap }, 422);
    return { existing, def: providerCatalog.get(existing.definition_id) };
  }

  function recordProbe(id: string, result: { ok: boolean; latencyMs?: number; error?: string }): void {
    bindings.providers.recordHealth(id, result.ok ? 'ok' : 'failed', {
      latencyMs: result.latencyMs,
      lastError: result.error,
    });
  }

  app.post('/:id/probe/llm', async (c) => {
    const id = c.req.param('id');
    const parsed = probeModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    const ctx = requireCapability(c, id, 'llm');
    if (ctx instanceof Response) return ctx;
    const enabledLlm    = bindings.providerLlmModels.listByProvider(id);
    const modelsDevId = ctx.def ? modelsDevIdFor(ctx.def, 'llm') : undefined;
    const catalogLlmIds = modelsDevId
      ? bindings.modelCatalog.listLlmModelIds(modelsDevId)
      : [];
    const model = parsed.data.model ?? enabledLlm[0]?.model ?? catalogLlmIds[0];
    if (!model) return c.json({ ok: false, model: '', latencyMs: null, error: '没有可探测的模型，请先在下方「模型」启用一个' });
    const result = await bindings.llm.probe(id, model, c.req.raw.signal);
    recordProbe(id, result);
    return c.json({ ...result, model });
  });

  app.post('/:id/probe/vision', async (c) => {
    const id = c.req.param('id');
    const parsed = probeModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    const ctx = requireCapability(c, id, 'vision');
    if (ctx instanceof Response) return ctx;
    const model = parsed.data.model
      ?? (ctx.def ? staticModelsFor(ctx.def, 'vision')[0] : undefined)
      ?? '';
    const result = await bindings.vision.probe(id, model || undefined);
    recordProbe(id, result);
    return c.json({ ok: result.ok, model, latencyMs: result.latencyMs ?? null, error: result.error });
  });

  app.post('/:id/probe/embed', async (c) => {
    const id = c.req.param('id');
    const parsed = probeModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    const ctx = requireCapability(c, id, 'embed');
    if (ctx instanceof Response) return ctx;
    const enabledEmbed = bindings.providerEmbedModels.listByProvider(id);
    const model = parsed.data.model
      ?? enabledEmbed[0]?.model
      ?? (ctx.def ? staticModelsFor(ctx.def, 'embed')[0] : undefined);
    if (!model) return c.json({ ok: false, model: '', latencyMs: null, error: '没有可探测的模型，请先在下方「模型」启用一个' });
    const result = await bindings.ebd.probeEmbed(id, model);
    recordProbe(id, result);
    return c.json({ ...result, model });
  });

  app.post('/:id/probe/rerank', async (c) => {
    const id = c.req.param('id');
    const parsed = probeModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    const ctx = requireCapability(c, id, 'rerank');
    if (ctx instanceof Response) return ctx;
    const enabledRerank = bindings.providerRerankModels.listByProvider(id);
    const model = parsed.data.model
      ?? enabledRerank[0]?.model
      ?? (ctx.def ? staticModelsFor(ctx.def, 'rerank')[0] : undefined)
      ?? '';
    if (!model) return c.json({ ok: false, model: '', latencyMs: null, error: '没有可探测的模型，请先在下方「模型」启用一个' });
    const result = await bindings.ebd.probeRerank(id, model);
    recordProbe(id, result);
    return c.json({ ...result, model });
  });

  app.post('/:id/probe/tts', async (c) => {
    const id = c.req.param('id');
    const ctx = requireCapability(c, id, 'tts');
    if (ctx instanceof Response) return ctx;
    const result = await bindings.tts.probe(id);
    recordProbe(id, result);
    return c.json({ ok: result.ok, model: '', latencyMs: result.latencyMs ?? null, error: result.error });
  });

  app.post('/:id/probe/stt', async (c) => {
    const id = c.req.param('id');
    const ctx = requireCapability(c, id, 'stt');
    if (ctx instanceof Response) return ctx;
    const result = await bindings.stt.probe(id);
    recordProbe(id, { ok: result.ok, latencyMs: result.latencyMs, error: result.error });
    return c.json({ ok: result.ok, model: '', latencyMs: result.latencyMs ?? null, error: result.error });
  });

  // ── GET /api/providers/:id/models — available LLM models for the picker ─────
  //
  // Live /v1/models when the protocol supports it, else the definition's
  // curated defaults. Each model is annotated with its context window (token
  // table) and whether it's already enabled (provider_llm_models).
  app.get('/:id/models', async (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;
    const row = repo.get(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const { models, source } = await fetchLlmModels(row, {
      modelsDevId:  providerCatalog.get(row.definition_id)
        ? modelsDevIdFor(providerCatalog.get(row.definition_id)!, 'llm')
        : undefined,
      modelCatalog: bindings.modelCatalog,
    });
    const pool = bindings.providerLlmModels;
    const enabled = new Map(pool.listByProvider(id).map((m) => [m.model, m.context_window]));
    const definition = providerCatalog.get(row.definition_id);
    const modelsDevId = definition ? modelsDevIdFor(definition, 'llm') : undefined;

    return c.json({
      source,
      models: models.map((model): { id: string; contextWindow: number | null; enabled: boolean } => ({
        id:            model,
        contextWindow: enabled.get(model)
          ?? (modelsDevId ? bindings.modelCatalog.get(modelsDevId, model)?.contextWindow : undefined)
          ?? null,
        enabled:       enabled.has(model),
      })),
    });
  });

  // ── PUT /api/providers/:id/models/:model — enable a model ───────────────────
  app.put('/:id/models/:model', async (c) => {
    const id = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const body = enableModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const repo = bindings.providers;
    if (!repo.get(id)) return c.json({ error: 'not_found' }, 404);

    bindings.providerLlmModels.upsert({
      providerConfigId: id,
      model,
      contextWindow:    body.data.contextWindow,
      contextSource:    body.data.contextSource,
    });
    return c.body(null, 204);
  });

  // ── DELETE /api/providers/:id/models/:model — disable a model ───────────────
  //
  // Cascade: bindings referencing this (provider, model) are removed too
  // (option B — disabling a bound model takes its bindings with it; the
  // frontend confirms first).
  app.delete('/:id/models/:model', (c) => {
    const id = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));

    const removed = bindings.providerLlmModels.remove(id, model);
    if (!removed) return c.json({ error: 'not_found' }, 404);

    const cascaded = bindings.modelBindings.deleteByProviderModel(id, model);

    return c.json({ ok: true, cascadedBindings: cascaded });
  });

  // ── POST /:id/tts-test ───────────────────────────────────────────────────
  // Real TTS synthesis test — replaces the old "测试声音" that mis-fired an LLM
  // probe (hit /chat/completions with a TTS model → 400). Synthesizes the
  // sample text with the active card's voice via the SAME path as live TTS
  // and returns the audio bytes for the frontend to play.
  app.post('/:id/tts-test', async (c) => {
    const providerId = c.req.param('id');
    const body = ttsTestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const text  = body.data.text?.trim() || '你好，我是艾玛，很高兴认识你。';
    const model = body.data.model.trim();
    if (!model) return c.json({ error: 'model_required' }, 400);

    const adapter = bindings.tts.getAdapter(providerId);
    if (!adapter) return c.json({ error: 'tts_adapter_unavailable' }, 400);

    const card  = bindings.card.current();
    const voice = resolveVoice(card.id, bindings.card);
    if (!voice) {
      return c.json({ error: 'no_reference_audio', message: '当前角色卡未配置参考音频，无法测试声音克隆' }, 400);
    }

    try {
      const cache = new VoiceUriCache(bindings.settings);
      await ensureVoiceUri(voice, adapter, model, card.id, providerId, cache);
      if (!voice.voiceUri && adapter.protocol !== 'gpt-sovits-tts') {
        return c.json({ error: 'voice_upload_failed', message: '参考音频上传失败' }, 400);
      }

      const chunks: Uint8Array[] = [];
      let mime = 'audio/mpeg';
      for await (const ev of bindings.tts.synthesize({ providerId, model, text, voice, format: 'mp3' })) {
        if (ev.type === 'audio_chunk') { chunks.push(ev.bytes); mime = ev.mime; }
      }
      if (chunks.length === 0) return c.json({ error: 'no_audio', message: '合成未产生音频' }, 502);

      const total = chunks.reduce((n, b) => n + b.length, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const b of chunks) { buf.set(b, off); off += b.length; }
      return new Response(buf, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
    } catch (err) {
      return c.json({ error: 'tts_test_failed', message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // ── Embed model pool ─────────────────────────────────────────────────────────

  app.get('/:id/embed-models', async (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;
    const row = repo.get(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const { models, source } = await fetchEmbedModels(row);
    const pool = bindings.providerEmbedModels;
    const enabled = new Map(pool.listByProvider(id).map((m) => [m.model, m.dim]));

    return c.json({
      source,
      models: models.map((model) => ({
        id:      model,
        dim:     enabled.get(model) ?? null,
        enabled: enabled.has(model),
      })),
    });
  });

  app.put('/:id/embed-models/:model', async (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const body  = enableEmbedModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);

    const repo = bindings.providers;
    if (!repo.get(id)) return c.json({ error: 'not_found' }, 404);

    // Probe the real dimension by embedding a short text — the vector length is
    // ground truth (EmbedResponse.dim). Fall back to a caller-supplied dim only
    // when the probe fails (offline / provider error).
    let dim = body.data.dim;
    let dimSource: 'live' | 'table' | 'manual' = body.data.dimSource ?? 'manual';
    try {
      const res = await bindings.ebd.embed({ providerId: id, model, texts: ['test'] });
      if (res.dim > 0) { dim = res.dim; dimSource = 'live'; }
    } catch { /* keep fallback dim */ }

    if (!dim || dim <= 0) {
      return c.json({ error: 'dim_unknown', message: 'Could not probe embedding dimension; supply `dim` manually.' }, 422);
    }

    bindings.providerEmbedModels.upsert({ providerConfigId: id, model, dim, dimSource });
    return c.body(null, 204);
  });

  app.delete('/:id/embed-models/:model', (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const removed = bindings.providerEmbedModels.remove(id, model);
    if (!removed) return c.json({ error: 'not_found' }, 404);

    const cascaded = bindings.modelBindings.deleteByProviderModel(id, model);
    return c.json({ ok: true, cascadedBindings: cascaded });
  });

  // ── Rerank model pool ─────────────────────────────────────────────────────────

  app.get('/:id/rerank-models', (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;
    const row = repo.get(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const def = providerCatalog.get(row.definition_id);
    const models = def ? staticModelsFor(def, 'rerank') : [];
    const pool = bindings.providerRerankModels;
    const enabled = new Map(pool.listByProvider(id).map((m) => [m.model, m.max_chunks]));

    return c.json({
      source: 'static',
      models: models.map((model) => ({
        id:        model,
        maxChunks: enabled.get(model) ?? null,
        enabled:   enabled.has(model),
      })),
    });
  });

  app.put('/:id/rerank-models/:model', async (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const body  = enableRerankModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);

    const repo = bindings.providers;
    if (!repo.get(id)) return c.json({ error: 'not_found' }, 404);

    bindings.providerRerankModels.upsert({
      providerConfigId: id,
      model,
      maxChunks: body.data.maxChunks,
    });
    return c.body(null, 204);
  });

  app.delete('/:id/rerank-models/:model', (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const removed = bindings.providerRerankModels.remove(id, model);
    if (!removed) return c.json({ error: 'not_found' }, 404);

    const cascaded = bindings.modelBindings.deleteByProviderModel(id, model);
    return c.json({ ok: true, cascadedBindings: cascaded });
  });

  // ── TTS model pool ────────────────────────────────────────────────────────────

  app.get('/:id/tts-models', (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;
    const row = repo.get(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const def = providerCatalog.get(row.definition_id);
    const models = def ? staticModelsFor(def, 'tts') : [];
    const pool = bindings.providerTtsModels;
    const enabledSet = new Set(pool.listByProvider(id).map((m) => m.model));

    return c.json({
      source: 'static',
      models: models.map((model) => ({ id: model, enabled: enabledSet.has(model) })),
    });
  });

  app.put('/:id/tts-models/:model', async (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const repo  = bindings.providers;
    if (!repo.get(id)) return c.json({ error: 'not_found' }, 404);

    bindings.providerTtsModels.upsert({ providerConfigId: id, model });
    return c.body(null, 204);
  });

  app.delete('/:id/tts-models/:model', (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const removed = bindings.providerTtsModels.remove(id, model);
    if (!removed) return c.json({ error: 'not_found' }, 404);

    const cascaded = bindings.modelBindings.deleteByProviderModel(id, model);
    return c.json({ ok: true, cascadedBindings: cascaded });
  });

  // ── STT model pool ────────────────────────────────────────────────────────────

  app.get('/:id/stt-models', (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;
    const row = repo.get(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const def = providerCatalog.get(row.definition_id);
    const models = def ? staticModelsFor(def, 'stt') : [];
    const pool = bindings.providerSttModels;
    const enabledSet = new Set(pool.listByProvider(id).map((m) => m.model));

    return c.json({
      source: 'static',
      models: models.map((model) => ({ id: model, enabled: enabledSet.has(model) })),
    });
  });

  app.put('/:id/stt-models/:model', async (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const repo  = bindings.providers;
    if (!repo.get(id)) return c.json({ error: 'not_found' }, 404);

    bindings.providerSttModels.upsert({ providerConfigId: id, model });
    return c.body(null, 204);
  });

  app.delete('/:id/stt-models/:model', (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const removed = bindings.providerSttModels.remove(id, model);
    if (!removed) return c.json({ error: 'not_found' }, 404);

    const cascaded = bindings.modelBindings.deleteByProviderModel(id, model);
    return c.json({ ok: true, cascadedBindings: cascaded });
  });

  // ── Vision model pool ─────────────────────────────────────────────────────────

  app.get('/:id/vision-models', async (c) => {
    const id = c.req.param('id');
    const repo = bindings.providers;
    const row = repo.get(id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const { models, source } = await fetchVisionModels(row, {
      modelsDevId:  providerCatalog.get(row.definition_id)
        ? modelsDevIdFor(providerCatalog.get(row.definition_id)!, 'vision')
        : undefined,
      modelCatalog: bindings.modelCatalog,
    });
    const pool = bindings.providerVisionModels;
    const enabledSet = new Set(pool.listByProvider(id).map((m) => m.model));

    return c.json({
      source,
      models: models.map((model) => ({ id: model, enabled: enabledSet.has(model) })),
    });
  });

  app.put('/:id/vision-models/:model', async (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const repo  = bindings.providers;
    if (!repo.get(id)) return c.json({ error: 'not_found' }, 404);

    bindings.providerVisionModels.upsert({ providerConfigId: id, model });
    return c.body(null, 204);
  });

  app.delete('/:id/vision-models/:model', (c) => {
    const id    = c.req.param('id');
    const model = decodeURIComponent(c.req.param('model'));
    const removed = bindings.providerVisionModels.remove(id, model);
    if (!removed) return c.json({ error: 'not_found' }, 404);

    const cascaded = bindings.modelBindings.deleteByProviderModel(id, model);
    return c.json({ ok: true, cascadedBindings: cascaded });
  });

  return app;
}
