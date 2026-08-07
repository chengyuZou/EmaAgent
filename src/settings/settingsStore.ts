// 类型化设置的唯一入口:先 SQLite 落库、再发变更事件;读取每次过 decode,
// 坏值回落业务默认并每键告警一次。不持有内存缓存——KV 读是微秒级,
// 缓存只会引入"内存与库不一致"的心理负担,事件枢纽(revision/订阅)才是真实状态。
import type { SettingsRepo } from '@ema-agent/storage';
import { InvalidSettingValueError } from './errors.js';
import type {
  SettingsChangedEvent,
  SettingsChangedListener,
} from './events.js';
import type { SettingDefinition } from './types.js';

/** Store 只需要 KV 窄口;SQL 与事务归 src/storage。 */
export type SettingsRepository = Pick<
  SettingsRepo,
  'read' | 'set' | 'setMany' | 'delete'
>;

export class SettingsStore {
  private readonly listeners = new Set<SettingsChangedListener>();
  /** 坏值告警每键一次:持久值损坏极少见,但读取点可能位于每次操作的边界。 */
  private readonly warnedKeys = new Set<string>();
  private revision = 0;

  constructor(private readonly repository: SettingsRepository) {}

  get<T>(definition: SettingDefinition<T>): T {
    const stored = this.repository.read(definition.key);
    if (stored.status === 'found') {
      const decoded = definition.decode(stored.value);
      if (decoded.ok) return decoded.value;
    }
    if (stored.status !== 'missing' && !this.warnedKeys.has(definition.key)) {
      this.warnedKeys.add(definition.key);
      console.warn(`[settings] invalid persisted value, using default: ${definition.key}`);
    }
    // defaultValue 是全进程共享引用,克隆防止调用方改穿默认值。
    return structuredClone(definition.defaultValue);
  }

  set<T>(definition: SettingDefinition<T>, value: T): T {
    const decoded = definition.decode(value);
    if (!decoded.ok) throw new InvalidSettingValueError(definition.key);
    // 先落库后发事件:持久化失败时订阅者不得看到未生效的值。
    this.repository.set(definition.key, encodeValue(definition, decoded.value));
    this.publish([definition.key]);
    return decoded.value;
  }

  setMany(entries: readonly {
    definition: SettingDefinition<unknown>;
    value: unknown;
  }[]): void {
    const normalized = entries.map(({ definition, value }) => {
      const decoded = definition.decode(value);
      if (!decoded.ok) throw new InvalidSettingValueError(definition.key);
      return { definition, value: decoded.value };
    });
    this.repository.setMany(normalized.map(({ definition, value }) => ({
      key: definition.key,
      value: encodeValue(definition, value),
    })));
    this.publish(normalized.map((entry) => entry.definition.key));
  }

  delete(definition: SettingDefinition<unknown>): void {
    this.repository.delete(definition.key);
    this.publish([definition.key]);
  }

  subscribe(listener: SettingsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(changedKeys: readonly string[]): void {
    this.revision += 1;
    const event: SettingsChangedEvent = {
      revision: this.revision,
      changedKeys: [...changedKeys],
    };
    for (const listener of this.listeners) listener(event);
  }
}

function encodeValue<T>(definition: SettingDefinition<T>, value: T): unknown {
  return definition.encode ? definition.encode(value) : value;
}
