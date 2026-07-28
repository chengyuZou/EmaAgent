// 通过 SQLite 持久化类型化设置，并在提交成功后更新当前进程快照。

import type { SettingsRepo } from '@ema-agent/storage';
import { SettingsSnapshot } from './settingsSnapshot.js';
import {
  readSetting,
  updateSetting,
  updateSettings,
} from './updateSettings.js';
import type {
  SettingDefinition,
} from './types.js';
import type { SettingsChangedListener } from './events.js';

export class SettingsStore {
  private readonly snapshot = new SettingsSnapshot();

  constructor(
    private readonly repository: Pick<
      SettingsRepo,
      'read' | 'set' | 'setMany' | 'delete'
    >,
  ) {}

  get<T>(definition: SettingDefinition<T>): T {
    return readSetting(this.repository, this.snapshot, definition);
  }

  set<T>(definition: SettingDefinition<T>, value: T): T {
    return updateSetting(this.repository, this.snapshot, definition, value);
  }

  setMany(entries: readonly {
    definition: SettingDefinition<unknown>;
    value: unknown;
  }[]): void {
    updateSettings(this.repository, this.snapshot, entries);
  }

  delete(definition: SettingDefinition<unknown>): void {
    this.repository.delete(definition.key);
    this.snapshot.remove(definition.key);
    this.snapshot.publish([definition.key]);
  }

  subscribe(listener: SettingsChangedListener): () => void {
    return this.snapshot.subscribe(listener);
  }
}
