// 设置目录与展示投影：全量定义清单（供设置页渲染）与 eventDisplay 合并表特例。
import { Hono } from 'hono';
import type { SettingsStore } from '@ema-agent/settings';
import {
  eventDisplaySetting,
  resolveEventDisplay,
} from '../../composition/settings/eventDisplaySetting.js';

export interface SettingsCatalogRouteDeps {
  readonly settings: Pick<SettingsStore, 'listDefinitions' | 'get'>;
}

export function settingsCatalogRoute(deps: SettingsCatalogRouteDeps): Hono {
  const app = new Hono();

  // 设置目录：带 schema 描述的只读清单，按 key 排序（Store 已排）。
  app.get('/', context => {
    return context.json({ items: deps.settings.listDefinitions() });
  });

  // 事件提示条生效表：默认表 + 用户覆盖合并后的完整投影（前端免合并）。
  app.get('/event-display', context => {
    return context.json(resolveEventDisplay(deps.settings.get(eventDisplaySetting)));
  });

  return app;
}
