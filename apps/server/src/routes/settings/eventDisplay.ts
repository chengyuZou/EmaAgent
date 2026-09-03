// 返回事件提示条的生效展示表.

import { Hono } from 'hono';
import type { SettingsStore } from '@ema-agent/settings';
import {
  eventDisplaySetting,
  resolveEventDisplay,
} from '../../composition/settings/eventDisplaySetting.js';

export interface SettingsEventDisplayRouteDeps {
  readonly settings: Pick<SettingsStore, 'get'>;
}

export const settingsEventDisplayRoute = (deps: SettingsEventDisplayRouteDeps) =>
  new Hono().get('/event-display', context => {
    return context.json(resolveEventDisplay(deps.settings.get(eventDisplaySetting)));
  });
