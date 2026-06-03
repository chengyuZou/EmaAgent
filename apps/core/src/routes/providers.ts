import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ProvidersRepo, ModelBindingsRepo } from '@ema-agent/storage';
import type { ProviderConfigRow, ProviderHealthRow } from '@ema-agent/storage';
import {
  getProviderDefinition,
  PROVIDER_DEFINITIONS,
  type ProviderDefinition,
  type Capability,
} from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';
import {
  buildLlmProviderConfig,
  buildEmbedProviderConfig,
  buildRerankProviderConfig,
  configureBridge,
} from '../wiring.js';
import { reloadTtsClient } from '../wiring/tts.js';
import { reloadSttClient } from '../wiring/stt.js';

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
    hasApiKey:    !!config.api_key_plain,
    baseUrl:      config.base_url,
    enabled:      config.enabled === 1,
    capabilities: JSON.parse(config.capabilities_json) as Capability[],
    config:       JSON.parse(config.config_json) as Record<string, unknown>,
    health: health ? {
      status:       health.status,
      latencyMs:    health.latency_ms,
      lastError:    health.last_error,
      lastProbedAt: health.last_probed_at,
    } : null,
    definition: def ? {
      name:                def.name,
      defaultBaseUrl:      def.defaultBaseUrl,
      protocolBaseUrls:    def.protocolBaseUrls,
      protocols:           def.protocols,
      defaultModels:       def.defaultModels,
      iconKey:             def.iconKey,
      iconColor:           def.iconColor,
      requiresCredentials: def.requiresCredentials,
      onboardingFields:    def.onboardingFields,
    } : null,
  };
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  definitionId: z.string(),
  displayName:  z.string().optional(),
  apiKey:       z.string().optional(),
  baseUrl:      z.string().optional().nullable(),
  enabled:      z.boolean().default(true),
  capabilities: z.array(z.string()).optional(),
  config:       z.record(z.unknown()).default({}),
});

const patchSchema = z.object({
  displayName:  z.string().optional(),
  apiKey:       z.string().optional(),
  baseUrl:      z.string().optional().nullable(),
  enabled:      z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  config:       z.record(z.unknown()).optional(),
});

const probeSchema = z.object({
  model: z.string().optional(),
});

// ── Hot-reload ────────────────────────────────────────────────────────────────

// The three model_bindings modules that feed LightRAG's internal config.
// When a provider referenced by any of these changes, bridge must be re-pushed.
const BRIDGE_MODULES = ['embed', 'rerank', 'lightrag-llm'] as const;

/**
 * After any provider write:
 *  1. Sync LlmRouter (only if this provider has the 'llm' capability).
 *  2. Re-push bridge config (only if this provider is referenced by a
 *     bridge-relevant model_binding: embed / rerank / lightrag-llm).
 */
function hotReload(
  bindings: AppBindings,
  row: ProviderConfigRow,
  deleted = false,
): void {
  const capabilities: string[] = JSON.parse(row.capabilities_json);

  // ── LlmRouter sync ────────────────────────────────────────────────────────
  if (capabilities.includes('llm')) {
    if (deleted) {
      bindings.llm.removeConfig(row.id);
    } else {
      const cfg = buildLlmProviderConfig(row);
      if (cfg) bindings.llm.upsertConfig(cfg);
      else     bindings.llm.removeConfig(row.id);
    }
  }

  // ── EbdRouter sync ────────────────────────────────────────────────────────
  if (capabilities.includes('embed')) {
    if (deleted) {
      bindings.ebd.removeEmbedConfig(row.id);
    } else {
      const cfg = buildEmbedProviderConfig(row);
      if (cfg) bindings.ebd.upsertEmbedConfig(cfg);
      else     bindings.ebd.removeEmbedConfig(row.id);
    }
  }

  if (capabilities.includes('rerank')) {
    if (deleted) {
      bindings.ebd.removeRerankConfig(row.id);
    } else {
      const cfg = buildRerankProviderConfig(row);
      if (cfg) bindings.ebd.upsertRerankConfig(cfg);
      else     bindings.ebd.removeRerankConfig(row.id);
    }
  }

  // ── Bridge sync ───────────────────────────────────────────────────────────
  const mbRepo = new ModelBindingsRepo(bindings.profileDb.sqlite);
  const bridgeUsesThisProvider = BRIDGE_MODULES.some(
    mod => mbRepo.get(mod)?.providerConfigId === row.id,
  );
  if (bridgeUsesThisProvider) {
    void configureBridge(bindings.profileDb, bindings.narrative);
  }

  // ── TTS / STT sync ─────────────────────────────────────────────────────────
  // Rebuild the whole Façade rather than per-provider upsert — TTS adapters
  // are cheap to instantiate and the binding-lookup tables make targeted
  // updates not worth the complexity.
  if (capabilities.includes('tts')) reloadTtsClient(bindings.tts, bindings.profileDb);
  if (capabilities.includes('stt')) reloadSttClient(bindings.stt, bindings.profileDb);
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function providersRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // GET /api/providers/definitions  — full registry for the "Add Provider" picker
  app.get('/definitions', (c) => {
    const defs = Object.values(PROVIDER_DEFINITIONS).map(def => ({
      id:                  def.id,
      name:                def.name,
      defaultBaseUrl:      def.defaultBaseUrl,
      protocolBaseUrls:    def.protocolBaseUrls,
      capabilities:        def.capabilities,
      protocols:           def.protocols,
      defaultModels:       def.defaultModels,
      iconKey:             def.iconKey,
      iconColor:           def.iconColor,
      requiresCredentials: def.requiresCredentials,
      onboardingFields:    def.onboardingFields,
    }));
    return c.json(defs);
  });

  // GET /api/providers
  app.get('/', (c) => {
    const repo = new ProvidersRepo(bindings.profileDb.sqlite);
    const rows = repo.listWithHealth();
    return c.json(rows.map(({ config, health }) =>
      shapeProvider(config, health, getProviderDefinition(config.definition_id)),
    ));
  });

  // POST /api/providers
  app.post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    const def = getProviderDefinition(body.definitionId);
    if (!def) {
      return c.json({ error: 'unknown_definition', definitionId: body.definitionId }, 422);
    }

    const validCaps = (body.capabilities ?? [...def.capabilities]).filter(
      cap => (def.capabilities as readonly string[]).includes(cap),
    );

    const repo = new ProvidersRepo(bindings.profileDb.sqlite);
    const id = randomUUID();
    repo.upsert({
      id,
      definitionId: body.definitionId,
      displayName:  body.displayName ?? def.name,
      apiKey:       body.apiKey,
      baseUrl:      body.baseUrl ?? undefined,
      enabled:      body.enabled,
      capabilities: validCaps as Capability[],
      config:       body.config,
    });

    const row = repo.get(id)!;
    hotReload(bindings, row);

    return c.json(shapeProvider(row, null, def), 201);
  });

  // GET /api/providers/:id
  app.get('/:id', (c) => {
    const repo = new ProvidersRepo(bindings.profileDb.sqlite);
    const result = repo.getWithHealth(c.req.param('id'));
    if (!result) return c.json({ error: 'not_found' }, 404);
    const { config, health } = result;
    return c.json(shapeProvider(config, health, getProviderDefinition(config.definition_id)));
  });

  // PATCH /api/providers/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const repo = new ProvidersRepo(bindings.profileDb.sqlite);

    const existing = repo.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    const def = getProviderDefinition(existing.definition_id);
    const existingConfig = JSON.parse(existing.config_json) as Record<string, unknown>;
    const existingCaps   = JSON.parse(existing.capabilities_json) as Capability[];

    const validCaps = body.capabilities !== undefined
      ? (body.capabilities.filter(
          cap => !def || (def.capabilities as readonly string[]).includes(cap),
        ) as Capability[])
      : existingCaps;

    repo.upsert({
      id,
      definitionId: existing.definition_id,
      displayName:  body.displayName ?? existing.display_name,
      apiKey:       body.apiKey ?? existing.api_key_plain ?? undefined,
      baseUrl:      body.baseUrl !== undefined
        ? (body.baseUrl ?? undefined)
        : (existing.base_url ?? undefined),
      enabled:      body.enabled ?? existing.enabled === 1,
      capabilities: validCaps,
      config:       body.config ?? existingConfig,
    });

    const updated = repo.get(id)!;
    hotReload(bindings, updated);

    return c.json(shapeProvider(updated, repo.getHealth(id) ?? null, def));
  });

  // DELETE /api/providers/:id
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const repo = new ProvidersRepo(bindings.profileDb.sqlite);

    const existing = repo.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    repo.delete(id);
    hotReload(bindings, existing, true);

    return c.body(null, 204);
  });

  // POST /api/providers/:id/probe  — verify connectivity (LLM capability only)
  app.post('/:id/probe', async (c) => {
    const id = c.req.param('id');

    const parsed = probeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const repo = new ProvidersRepo(bindings.profileDb.sqlite);
    const existing = repo.get(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const def = getProviderDefinition(existing.definition_id);
    const model = parsed.data.model
      ?? def?.defaultModels?.llm?.[0]
      ?? 'gpt-4o-mini';
    const result = await bindings.llm.probe(id, model);

    repo.recordHealth(id, result.ok ? 'ok' : 'failed', {
      latencyMs: result.latencyMs,
      lastError: result.error,
    });

    return c.json(result);
  });

  return app;
}
