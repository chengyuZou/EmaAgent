// 设置目录与展示投影：全量定义清单（schema 转 JSON Schema 供设置页渲染）与 eventDisplay 合并表特例。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SettingsStore } from '@ema-agent/settings';
import {
  eventDisplaySetting,
  resolveEventDisplay,
} from '../../composition/settings/eventDisplaySetting.js';

export interface SettingsCatalogRouteDeps {
  readonly settings: Pick<SettingsStore, 'listDefinitions' | 'get'>;
}

export const settingsCatalogRoute = (deps: SettingsCatalogRouteDeps) =>
  new Hono()
    // 设置目录：扁平清单。Zod 不可跨 HTTP 传输，schema 在边界转 JSON Schema；
    // io:'input' 投影写入侧形状——带 transform（如 skills 去重）的 schema 在
    // 输出侧无法表达，设置页编辑的本来就是写入侧。
    .get('/', context => {
      const items = deps.settings.listDefinitions().map(definition => ({
        key: definition.key,
        label: definition.label,
        description: definition.description,
        apply: definition.apply,
        defaultValue: definition.defaultValue,
        schema: z.toJSONSchema(definition.schema, { io: 'input' }),
      }));
      return context.json({ items });
    })
    // 事件提示条生效表：默认表 + 用户覆盖合并后的完整投影（前端免合并）。
    .get('/event-display', context => {
      return context.json(resolveEventDisplay(deps.settings.get(eventDisplaySetting)));
    });
