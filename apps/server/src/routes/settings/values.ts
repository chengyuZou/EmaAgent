// 设置值读写：全量一次读取、单值 GET/PUT/DELETE（删即恢复默认）与批量保存（任一键非法整批拒绝）。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  InvalidSettingGroupValueError,
  InvalidSettingValueError,
  type SettingsStore,
} from '@ema-agent/settings';

export interface SettingsValuesRouteDeps {
  readonly settings: Pick<
    SettingsStore,
    'listDefinitions' | 'findDefinition' | 'get' | 'set' | 'setMany' | 'delete'
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

  // 首开设置页一次拿全量生效值（覆盖值或默认值），不按 key 逐条请求。
  app.get('/values', context => {
    const items = deps.settings.listDefinitions().map(definition => ({
      key: definition.key,
      value: deps.settings.get(definition),
    }));
    return context.json({ items });
  });

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
      return writeError(context, error, definition.key);
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
      return writeError(context, error, parsed.data.entries[0]?.key ?? '');
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

/** 单字段与跨字段约束的写错误分开映射；组错误带 groupId 供前端定位同组字段。 */
function writeError(context: Context, error: unknown, key: string): Response {
  if (error instanceof InvalidSettingGroupValueError) {
    return context.json({ error: 'invalid_setting_group', groupId: error.groupId }, 400);
  }
  if (error instanceof InvalidSettingValueError) {
    return context.json({ error: 'invalid_setting_value', key }, 400);
  }
  throw error;
}
