// 校验设置 HTTP 输入，并把类型化读写委托给 SettingsStore。

import { Hono } from 'hono';
import { z } from 'zod';
import {
  knowledgeModelsSetting,
} from '@ema-agent/knowledge';
import {
  MAX_PERMISSION_ASK_TIMEOUT_MS,
  MIN_PERMISSION_ASK_TIMEOUT_MS,
  permissionAskTimeoutSetting,
} from '@ema-agent/permission';
import {
  InvalidSettingValueError,
  type SettingsCatalog,
  type SettingsStore,
} from '@ema-agent/settings';
import { themeSetting } from '@ema-agent/theme';
import {
  DEFAULT_EVENT_DISPLAY,
  eventDisplaySetting,
} from '../settings/eventDisplaySetting.js';

const eventDisplayConfigSchema = z.object({
  enabled: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  durationMs: z.number().int().min(0).max(600_000).nullable(),
  truncateChars: z.number().int().min(1).max(10_000).optional(),
});
const eventDisplayBodySchema = z.record(z.string(), eventDisplayConfigSchema);

const permissionTimeoutBodySchema = z.object({
  timeoutMs: z.number()
    .int()
    .min(MIN_PERMISSION_ASK_TIMEOUT_MS)
    .max(MAX_PERMISSION_ASK_TIMEOUT_MS),
});

const themeBodySchema = z.object({
  hue: z.number().min(0).max(360).optional(),
  radius: z.number().min(0).max(3).optional(),
  mode: z.enum(['light', 'dark']).optional(),
  contentFontPreset: z.enum(['system', 'rounded', 'reading', 'custom']).optional(),
  contentFontFamily: z.string()
    .max(80)
    .regex(/^[\p{L}\p{N} _.-]*$/u)
    .optional(),
});

const kbModelRefSchema = z.object({
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
});
const kbModelsBodySchema = z.object({
  embed: kbModelRefSchema.nullish(),
  rerank: kbModelRefSchema.nullish(),
});

export interface SettingsRouteDependencies {
  settings: Pick<SettingsStore, 'get' | 'set'>;
  catalog: Pick<SettingsCatalog, 'find' | 'list'>;
  /** 只影响之后进入等待队列的 Permission/AskUser。 */
  setDefaultPermissionTimeout(timeoutMs: number): void;
}

export function settingsRoute(dependencies: SettingsRouteDependencies): Hono {
  const app = new Hono();
  const settings = dependencies.settings;

  app.get('/catalog', (c) => c.json(dependencies.catalog.list()));

  app.get('/values/:key', (c) => {
    const definition = dependencies.catalog.find(c.req.param('key'));
    if (!definition) {
      return c.json({ error: 'setting_not_found' }, 404);
    }
    return c.json({
      key: definition.key,
      apply: definition.apply,
      value: settings.get(definition),
    });
  });

  app.put('/values/:key', async (c) => {
    const definition = dependencies.catalog.find(c.req.param('key'));
    if (!definition) {
      return c.json({ error: 'setting_not_found' }, 404);
    }

    const body = await readJson(c.req);
    if (!isRecord(body) || !Object.hasOwn(body, 'value')) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const value = settings.set(definition, body.value);
      if (
        definition.key === permissionAskTimeoutSetting.key
        && typeof value === 'number'
      ) {
        dependencies.setDefaultPermissionTimeout(value);
      }
      return c.json({
        key: definition.key,
        apply: definition.apply,
        value,
      });
    } catch (error) {
      if (error instanceof InvalidSettingValueError) {
        return c.json({
          error: 'invalid_setting_value',
          settingKey: error.settingKey,
        }, 400);
      }
      throw error;
    }
  });

  app.get('/event-display', (c) => {
    const overrides = settings.get(eventDisplaySetting);
    return c.json({
      defaults: DEFAULT_EVENT_DISPLAY,
      overrides,
      effective: { ...DEFAULT_EVENT_DISPLAY, ...overrides },
    });
  });

  app.put('/event-display', async (c) => {
    const parsed = eventDisplayBodySchema.safeParse(await readJson(c.req));
    if (!parsed.success) return invalidRequest(c, parsed.error);

    const overrides = settings.set(eventDisplaySetting, parsed.data);
    return c.json({
      defaults: DEFAULT_EVENT_DISPLAY,
      overrides,
      effective: { ...DEFAULT_EVENT_DISPLAY, ...overrides },
    });
  });

  app.get('/permission-timeout', (c) => {
    return c.json({ timeoutMs: settings.get(permissionAskTimeoutSetting) });
  });

  app.put('/permission-timeout', async (c) => {
    const parsed = permissionTimeoutBodySchema.safeParse(await readJson(c.req));
    if (!parsed.success) return invalidRequest(c, parsed.error);

    const timeoutMs = settings.set(
      permissionAskTimeoutSetting,
      parsed.data.timeoutMs,
    );
    dependencies.setDefaultPermissionTimeout(timeoutMs);
    return c.json({ timeoutMs });
  });

  app.get('/theme', (c) => c.json(settings.get(themeSetting)));

  app.put('/theme', async (c) => {
    const parsed = themeBodySchema.safeParse(await readJson(c.req));
    if (!parsed.success) return invalidRequest(c, parsed.error);

    const current = settings.get(themeSetting);
    return c.json(settings.set(themeSetting, { ...current, ...parsed.data }));
  });

  app.get('/kb-models', (c) => c.json(settings.get(knowledgeModelsSetting)));

  app.put('/kb-models', async (c) => {
    const parsed = kbModelsBodySchema.safeParse(await readJson(c.req));
    if (!parsed.success) return invalidRequest(c, parsed.error);

    return c.json(settings.set(knowledgeModelsSetting, parsed.data));
  });

  return app;
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null);
}

function invalidRequest(
  context: { json(body: unknown, status: 400): Response },
  error: z.ZodError,
): Response {
  return context.json({
    error: 'invalid_request',
    details: error.flatten(),
  }, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
