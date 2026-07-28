// 在 Composition Root 用 profile.db 创建用户设置快照和运行时缓存入口。

import { SettingsStore } from '@ema-agent/settings';
import { SettingsRepo, type SqliteDb } from '@ema-agent/storage';

export interface CreatedSettings {
  /** 用户可编辑设置的类型化入口。 */
  settings: SettingsStore;
  /** TTS 声音 URI 等非用户配置暂时复用原 KV 表。 */
  runtimeCache: SettingsRepo;
}

export function createSettingsStore(profileDb: SqliteDb): CreatedSettings {
  const repository = new SettingsRepo(profileDb);
  return {
    settings: new SettingsStore(repository),
    runtimeCache: repository,
  };
}
