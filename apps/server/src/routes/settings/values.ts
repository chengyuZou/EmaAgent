// 设置值读写：单值 GET/PUT/DELETE（删即恢复默认）与批量保存（任一键非法整批拒绝）。
import { Hono } from 'hono';
import { z } from 'zod';
import { InvalidSettingValueError, type SettingsStore } from '@ema-agent/settings';

export interface SettingsValuesRouteDeps {
  readonly settings: Pick<
    SettingsStore,
    'findDefinition' | 'get' | 'set' | 'setMany' | 'delete'
  >;
}

const putBody = z.object({
  value: z.unknown(),
});

const batchBody = z.object({
  entries: z.array(z.object({
    key: z.string().min(1),
    value: z.unknown(),
  })).min(1).max(100),
});

export function settingsValuesRoute(deps: SettingsValuesRouteDeps): Hono {
  const app = new Hono();

  app.get('/values/:key', context => {
    const definition = deps.settings.findDefinition(context.req.param('key'));
    if (!definition) return context.json({ error: 'unknown_setting_key' }, 404);
    return context.json({ key: definition.key, value: deps.settings.get(definition) });
  });

  app.put('/values/:key', async context => {
    const definition = deps.settings.findDefinition(context.req.param('key'));
    if (!definition) return context.json({ error: 'unknown_setting_key' }, 404);
    const parsed = putBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const value = deps.settings.set(definition, parsed.data.value);
      return context.json({ key: definition.key, value });
    } catch (error) {
      if (error instanceof InvalidSettingValueError) {
        return context.json({ error: 'invalid_setting_value', key: definition.key }, 400);
      }
      throw error;
    }
  });

  // 批量保存：任一键未知或值非法即整批拒绝（Store 内原子落库）。
  app.put('/values', async context => {
    const parsed = batchBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const entries = [];
    for (const entry of parsed.data.entries) {
      const definition = deps.settings.findDefinition(entry.key);
      if (!definition) {
        return context.json({ error: 'unknown_setting_key', key: entry.key }, 404);
      }
      entries.push({ definition, value: entry.value });
    }
    try {
      deps.settings.setMany(entries);
      return context.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidSettingValueError) {
        return context.json({ error: 'invalid_setting_value', key: error.message }, 400);
      }
      throw error;
    }
  });

  app.delete('/values/:key', context => {
    const definition = deps.settings.findDefinition(context.req.param('key'));
    if (!definition) return context.json({ error: 'unknown_setting_key' }, 404);
    deps.settings.delete(definition);
    return context.json({ ok: true });
  });

  return app;
}
