// 设置值读写：全量一次读取、单值 GET/PUT/DELETE（删即恢复默认）与批量保存（任一键非法整批拒绝）。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  InvalidSettingGroupValueError,
  InvalidSettingValueError,
  type SettingsStore,
} from '@ema-agent/settings';
import { jsonBody } from '../validate.js';

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

export const settingsValuesRoute = (deps: SettingsValuesRouteDeps) =>
  new Hono()
    // 首开设置页一次拿全量生效值（覆盖值或默认值），不按 key 逐条请求。
    .get('/values', context => {
      const items = deps.settings.listDefinitions().map(definition => ({
        key: definition.key,
        value: deps.settings.get(definition),
      }));
      return context.json({ items });
    })
    .get('/values/:key', context => {
      const definition = deps.settings.findDefinition(context.req.param('key'));
      if (!definition) return context.json({ error: 'unknown_setting_key' }, 404);
      return context.json({ key: definition.key, value: deps.settings.get(definition) });
    })
    .put('/values/:key', jsonBody(putBody), async context => {
      const definition = deps.settings.findDefinition(context.req.param('key'));
      if (!definition) return context.json({ error: 'unknown_setting_key' }, 404);
      const { value } = context.req.valid('json');
      try {
        const saved = deps.settings.set(definition, value);
        return context.json({ key: definition.key, value: saved });
      } catch (error) {
        return writeError(context, error, definition.key);
      }
    })
    // 批量保存：任一键未知或值非法即整批拒绝（Store 内原子落库）。
    .put('/values', jsonBody(batchBody), async context => {
      const { entries: rawEntries } = context.req.valid('json');
      const entries = [];
      for (const entry of rawEntries) {
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
        return writeError(context, error, rawEntries[0]?.key ?? '');
      }
    })
    .delete('/values/:key', context => {
      const definition = deps.settings.findDefinition(context.req.param('key'));
      if (!definition) return context.json({ error: 'unknown_setting_key' }, 404);
      deps.settings.delete(definition);
      return context.json({ ok: true });
    });

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
