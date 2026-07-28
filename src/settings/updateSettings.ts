// 执行设置的读取与提交顺序，确保内存快照不会领先于 SQLite。

import type { SettingsRepo } from '@ema-agent/storage';
import { InvalidSettingValueError } from './errors.js';
import { SettingsSnapshot } from './settingsSnapshot.js';
import type { SettingDefinition } from './types.js';

export type SettingsRepository = Pick<
  SettingsRepo,
  'read' | 'set' | 'setMany' | 'delete'
>;

export function readSetting<T>(
  repository: SettingsRepository,
  snapshot: SettingsSnapshot,
  definition: SettingDefinition<T>,
): T {
  if (snapshot.has(definition.key)) return snapshot.get<T>(definition.key);

  const stored = repository.read(definition.key);
  if (stored.status === 'found') {
    const decoded = definition.decode(stored.value);
    if (decoded.ok) {
      snapshot.replace(definition.key, decoded.value);
      return snapshot.get<T>(definition.key);
    }
  }

  if (stored.status !== 'missing') {
    console.warn(`[settings] invalid persisted value, using default: ${definition.key}`);
  }
  snapshot.replace(definition.key, definition.defaultValue);
  return snapshot.get<T>(definition.key);
}

export function updateSetting<T>(
  repository: SettingsRepository,
  snapshot: SettingsSnapshot,
  definition: SettingDefinition<T>,
  value: T,
): T {
  const decoded = definition.decode(value);
  if (!decoded.ok) throw new InvalidSettingValueError(definition.key);

  const normalized = structuredClone(decoded.value);
  repository.set(definition.key, definition.encode(normalized));
  snapshot.replace(definition.key, normalized);
  snapshot.publish([definition.key]);
  return structuredClone(normalized);
}

export function updateSettings(
  repository: SettingsRepository,
  snapshot: SettingsSnapshot,
  entries: readonly {
    definition: SettingDefinition<unknown>;
    value: unknown;
  }[],
): void {
  const normalized = entries.map(({ definition, value }) => {
    const decoded = definition.decode(value);
    if (!decoded.ok) throw new InvalidSettingValueError(definition.key);
    return { definition, value: structuredClone(decoded.value) };
  });

  repository.setMany(normalized.map(({ definition, value }) => ({
    key: definition.key,
    value: definition.encode(value),
  })));
  for (const entry of normalized) {
    snapshot.replace(entry.definition.key, entry.value);
  }
  snapshot.publish(normalized.map(entry => entry.definition.key));
}
