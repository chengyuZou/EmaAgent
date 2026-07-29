// 在 LocalHost 装配各业务包公开的 V1 设置定义，供 Route 和前端查询。

import { agentSetting } from '@ema-agent/agent';
import { attachmentSetting } from '@ema-agent/attachment';
import { contextCompactionSetting } from '@ema-agent/context';
import { knowledgeModelsSetting, knowledgeRetrievalSetting } from '@ema-agent/knowledge';
import { permissionAskTimeoutSetting } from '@ema-agent/permission';
import { SettingsCatalog } from '@ema-agent/settings';
import { themeSetting } from '@ema-agent/theme';
import { visionSetting } from '@ema-agent/vision';
import { eventDisplaySetting } from './eventDisplaySetting.js';

export function createSettingsCatalog(): SettingsCatalog {
  const catalog = new SettingsCatalog();
  catalog.register(agentSetting);
  catalog.register(attachmentSetting);
  catalog.register(contextCompactionSetting);
  catalog.register(eventDisplaySetting);
  catalog.register(knowledgeModelsSetting);
  catalog.register(knowledgeRetrievalSetting);
  catalog.register(permissionAskTimeoutSetting);
  catalog.register(themeSetting);
  catalog.register(visionSetting);
  return catalog;
}
