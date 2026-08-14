// 在 LocalHost 装配各业务包公开的 V1 设置定义，供 Route 和前端查询。

import { agentSetting } from '@ema-agent/agent';
import { attachmentSetting } from '@ema-agent/attachment';
import { contextCompactionSetting } from '@ema-agent/context';
import { knowledgeModelsSetting, knowledgeRetrievalSetting } from '@ema-agent/knowledge';
import {
  memoryMaintenanceSetting,
  memoryModelsSetting,
  memoryStorageSetting,
} from '@ema-agent/memory';
import { permissionAskTimeoutSetting } from '@ema-agent/permission';
import { SettingsCatalog } from '@ema-agent/settings';
import {
  builtinSkillsEnabledSetting,
  disabledProjectSourcesSetting,
  disabledSkillKeysSetting,
} from '@ema-agent/skills';
import { backgroundProcessSetting } from '@ema-agent/tools';
import { visionSetting } from '@ema-agent/vision';
import { eventDisplaySetting } from './eventDisplaySetting.js';
import { themeSetting } from './themeSetting.js';

export function createSettingsCatalog(): SettingsCatalog {
  const catalog = new SettingsCatalog();
  catalog.register(agentSetting);
  catalog.register(attachmentSetting);
  catalog.register(backgroundProcessSetting);
  catalog.register(contextCompactionSetting);
  catalog.register(eventDisplaySetting);
  catalog.register(knowledgeModelsSetting);
  catalog.register(knowledgeRetrievalSetting);
  catalog.register(memoryMaintenanceSetting);
  catalog.register(memoryModelsSetting);
  catalog.register(memoryStorageSetting);
  catalog.register(permissionAskTimeoutSetting);
  catalog.register(builtinSkillsEnabledSetting);
  catalog.register(disabledProjectSourcesSetting);
  catalog.register(disabledSkillKeysSetting);
  catalog.register(themeSetting);
  catalog.register(visionSetting);
  return catalog;
}
