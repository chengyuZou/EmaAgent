import type { SettingsRepo } from '@ema-agent/storage';
import {
  InvalidSettingGroupValueError,
  InvalidSettingValueError,
} from './errors.js';
import type {
  SettingsChangedEvent,
  SettingsChangedListener,
} from './events.js';
import type { SettingDefinition, SettingGroup } from './types.js';

export type SettingsRepository = Pick<
  SettingsRepo,
  'read' | 'set' | 'setMany' | 'delete'
>;

export interface SettingsStoreOptions {
  /** 业务包提供的设置定义, 重复 key 会在注册时抛错. */
  readonly definitions?: readonly SettingDefinition<unknown>[];
  /** set/setMany 写入组内字段时, 使用整组新值检查跨字段约束. */
  readonly groups?: readonly SettingGroup[];
}

export class SettingsStore {
  private readonly listeners = new Set<SettingsChangedListener>();
  // 同一个坏值可能被多次读取, 每个实例对每个 key 只告警一次, 避免重复输出.
  private readonly warnedKeys = new Set<string>();
  private readonly definitions = new Map<string, SettingDefinition<unknown>>();
  private readonly groupsById = new Map<string, SettingGroup>();
  private revision = 0;

  constructor(
    private readonly repository: SettingsRepository,
    options: SettingsStoreOptions = {},
  ) {
    for (const definition of options.definitions ?? []) {
      this.register(definition);
    }
    for (const group of options.groups ?? []) {
      this.groupsById.set(group.id, group);
    }
  }

  register<T>(definition: SettingDefinition<T>): void {
    if (this.definitions.has(definition.key)) {
      throw new Error(`Duplicate setting key: ${definition.key}`);
    }
    this.definitions.set(
      definition.key,
      definition as SettingDefinition<unknown>,
    );
  }

  listDefinitions(): SettingDefinition<unknown>[] {
    return [...this.definitions.values()]
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  findDefinition(key: string): SettingDefinition<unknown> | undefined {
    return this.definitions.get(key);
  }

  get<T>(definition: SettingDefinition<T>): T {
    const stored = this.repository.read(definition.key);
    if (stored.status === 'found') {
      const parsed = definition.schema.safeParse(stored.value);
      if (parsed.success) return parsed.data;
    }
    if (stored.status !== 'missing' && !this.warnedKeys.has(definition.key)) {
      this.warnedKeys.add(definition.key);
      console.warn(`[settings] invalid persisted value, using default: ${definition.key}`);
    }
    // 默认值由定义对象共享. 返回副本, 避免调用方修改后影响后续读取.
    return structuredClone(definition.defaultValue);
  }

  set<T>(definition: SettingDefinition<T>, value: T): T {
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) throw new InvalidSettingValueError(definition.key);
    if (definition.group) {
      this.assertGroupValid(definition.group, { [definition.key]: parsed.data });
    }
    // 先保存再通知, 写入失败时不能让订阅者误以为新值已生效.
    this.repository.set(definition.key, parsed.data);
    this.publish([definition.key]);
    return parsed.data;
  }

  setMany(entries: readonly {
    definition: SettingDefinition<unknown>;
    value: unknown;
  }[]): void {
    const normalized = entries.map(({ definition, value }) => {
      const parsed = definition.schema.safeParse(value);
      if (!parsed.success) throw new InvalidSettingValueError(definition.key);
      return { definition, value: parsed.data };
    });
    // 同一批的新值一起校验. 组内未修改的字段使用当前有效值或默认值.
    const changed: Record<string, unknown> = Object.fromEntries(
      normalized.map((entry) => [entry.definition.key, entry.value]),
    );
    const groupIds = new Set<string>();
    for (const entry of normalized) {
      if (entry.definition.group) groupIds.add(entry.definition.group);
    }
    for (const groupId of groupIds) {
      this.assertGroupValid(groupId, changed);
    }
    this.repository.setMany(normalized.map(({ definition, value }) => ({
      key: definition.key,
      value,
    })));
    this.publish(normalized.map((entry) => entry.definition.key));
  }

  /** 删除用户覆盖值, 后续读取使用默认值. 此操作不检查设置组约束. */
  delete(definition: SettingDefinition<unknown>): void {
    this.repository.delete(definition.key);
    this.publish([definition.key]);
  }

  /** 写入成功后同步通知. 监听器抛错会向上传递, 但不会撤销已保存的设置. */
  subscribe(listener: SettingsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private assertGroupValid(
    groupId: string,
    overrides: Readonly<Record<string, unknown>>,
  ): void {
    const group = this.groupsById.get(groupId);
    if (!group) throw new InvalidSettingGroupValueError(groupId, `未注册的设置组: ${groupId}`);
    const values = this.collectGroupValues(group, overrides);
    const parsed = group.schema.safeParse(values);
    if (!parsed.success) {
      throw new InvalidSettingGroupValueError(groupId);
    }
  }

  private collectGroupValues(
    group: SettingGroup,
    overrides: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const definition of group.definitions) {
      const override = overrides[definition.key];
      if (override !== undefined) {
        values[definition.key] = override;
        continue;
      }
      const stored = this.repository.read(definition.key);
      if (stored.status === 'found') {
        const parsed = definition.schema.safeParse(stored.value);
        values[definition.key] = parsed.success
          ? parsed.data
          : structuredClone(definition.defaultValue);
      } else {
        values[definition.key] = structuredClone(definition.defaultValue);
      }
    }
    return values;
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
