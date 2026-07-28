// 暴露 Provider 配置、能力开关和密钥查看 HTTP 协议，不直接操作数据库或运行时。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  PROTOCOL_FAMILIES,
  PROVIDER_CONFIG_LIMITS,
  ProviderConfigurationError,
  type ConfiguredProvider,
  type ProviderConfiguration,
  type ProviderConfigurationSnapshot,
  type ProviderDefinition,
} from '@ema-agent/provider';

export const providerCredentialOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keep') }).strict(),
  z.object({
    type: z.literal('replace'),
    value: z.string().min(1).max(PROVIDER_CONFIG_LIMITS.apiKeyChars),
  }).strict(),
  z.object({ type: z.literal('clear') }).strict(),
]);

const capabilityConfigurationSchema = z.object({
  capability: z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']),
  protocol: z.enum(PROTOCOL_FAMILIES).optional().nullable(),
  baseUrl: z.string().max(PROVIDER_CONFIG_LIMITS.baseUrlChars).optional().nullable(),
  embeddingRevision: z.string().max(256).optional().nullable(),
  enabled: z.boolean().optional(),
}).strict();

const createSchema = z.object({
  definitionId: z.string(),
  displayName: z.string().optional(),
  apiKey: z.string().max(PROVIDER_CONFIG_LIMITS.apiKeyChars).optional(),
  enabled: z.boolean().default(true),
  capabilities: z.array(capabilityConfigurationSchema).optional(),
}).strict();

const patchSchema = z.object({
  displayName: z.string().optional(),
  credential: providerCredentialOperationSchema.optional(),
  enabled: z.boolean().optional(),
  capability: capabilityConfigurationSchema.optional(),
}).strict();

export function providerConfigurationRoute(
  configuration: ProviderConfiguration,
): Hono {
  const app = new Hono();

  app.get('/definitions', (c) => c.json(configuration.definitionsList()));

  app.get('/', (c) => {
    return c.json(configuration.list().map((snapshot) => shapeSnapshot(
      snapshot,
      configuration.definition(snapshot.config.definitionId),
    )));
  });

  app.post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const config = configuration.create({
        definitionId: parsed.data.definitionId,
        displayName: parsed.data.displayName,
        credential: parsed.data.apiKey,
        enabled: parsed.data.enabled,
        capabilities: parsed.data.capabilities,
      });
      return c.json(shapeConfig(
        config,
        null,
        configuration.definition(config.definitionId),
      ), 201);
    } catch (error) {
      return providerConfigurationError(c, error);
    }
  });

  app.get('/:id', (c) => {
    try {
      const snapshot = configuration.get(c.req.param('id'));
      return c.json(shapeSnapshot(
        snapshot,
        configuration.definition(snapshot.config.definitionId),
      ));
    } catch (error) {
      return providerConfigurationError(c, error);
    }
  });

  app.patch('/:id', async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      configuration.update(c.req.param('id'), parsed.data);
      const snapshot = configuration.get(c.req.param('id'));
      return c.json(shapeSnapshot(
        snapshot,
        configuration.definition(snapshot.config.definitionId),
      ));
    } catch (error) {
      return providerConfigurationError(c, error);
    }
  });

  app.delete('/:id', (c) => {
    try {
      configuration.delete(c.req.param('id'));
      return c.body(null, 204);
    } catch (error) {
      return providerConfigurationError(c, error);
    }
  });

  app.post('/:id/credential/reveal', (c) => {
    try {
      const credential = configuration.revealCredential(c.req.param('id'));
      c.header('Cache-Control', 'no-store, private');
      c.header('Pragma', 'no-cache');
      return c.json({ credential });
    } catch (error) {
      return providerConfigurationError(c, error);
    }
  });

  return app;
}

function shapeSnapshot(
  snapshot: ProviderConfigurationSnapshot,
  definition: ProviderDefinition | undefined,
) {
  return shapeConfig(snapshot.config, snapshot.health, definition);
}

function shapeConfig(
  config: ConfiguredProvider,
  health: ProviderConfigurationSnapshot['health'],
  definition: ProviderDefinition | undefined,
) {
  return {
    id: config.id,
    definitionId: config.definitionId,
    displayName: config.displayName,
    hasApiKey: !!config.credential,
    enabled: config.enabled,
    capabilities: config.capabilities,
    health: health ? {
      status: health.status,
      latencyMs: health.latencyMs,
      lastError: health.lastError,
      lastProbedAt: health.lastProbedAt,
    } : null,
    definition: definition ?? null,
  };
}

export function providerConfigurationError(
  c: Context,
  error: unknown,
) {
  if (!(error instanceof ProviderConfigurationError)) throw error;
  switch (error.code) {
    case 'not_found':
      return c.json({ error: 'not_found' }, 404);
    case 'unknown_definition':
      return c.json({
        error: 'unknown_definition',
        definitionId: error.definitionId,
      }, 422);
    case 'invalid_capability_config':
      return c.json({
        error: 'invalid_capability_config',
        message: error.message,
      }, 422);
    case 'capability_not_supported':
      return c.json({
        error: 'capability_not_supported',
        message: error.message,
      }, 422);
    case 'provider_capability_in_use':
      return c.json({
        error: 'provider_capability_in_use',
        message: error.message,
        bindings: error.conflicts,
      }, 409);
    case 'provider_in_use':
      return c.json({
        error: 'provider_in_use',
        message: error.message,
        bindings: error.conflicts,
      }, 409);
  }
}
