// 类型化设置的唯一入口:先 SQLite 落库、再发变更事件;读取每次过 zod safeParse,
// 坏值回落业务默认并每键告警一次。不持有内存缓存——KV 读是微秒级,
// 缓存只会引入"内存与库不一致"的心理负担,事件枢纽(revision/订阅)才是真实状态。
// schema 驱动:校验、类型推导、UI 描述全部来自 SettingDefinition.schema;
// 有跨字段约束的 key 用 SettingGroup 声明,set/setMany 时整组 refine。
// 同时承担字段目录职能(原 SettingsCatalog 已并入):构造时注册各业务包的
// defineSetting,listDefinitions/findDefinition 供设置界面查询。
// 字段定义(schema/defaultValue/apply)永远在代码,不进 SQL——settings 表
// 只存"用户改了什么";UI 的默认值/选项/说明从本目录的 schema 读取。
import type { SettingsRepo } from '@ema-agent/storage';
import {
  InvalidSettingGroupValueError,
  InvalidSettingValueError,
} from './errors.js';
import type {
  SettingsChangedEvent,
  SettingsChangedListener,
} from './events.js';
import {
  describeSetting,
  type SettingDefinition,
  type SettingDescriptor,
  type SettingGroup,
} from './types.js';

/** Store 只需要 KV 窄口;SQL 与事务归 src/storage。 */
export type SettingsRepository = Pick<
  SettingsRepo,
  'read' | 'set' | 'setMany' | 'delete'
>;

export interface SettingsStoreOptions {
  /** 各业务包公开的设置定义目录;重复 key 启动期 fail-fast。 */
  readonly definitions?: readonly SettingDefinition<unknown>[];
  /** 有跨字段约束的设置组;set 组内 key 或 setMany 提交一组时整组 refine。 */
  readonly groups?: readonly SettingGroup[];
}

export class SettingsStore {
  private readonly listeners = new Set<SettingsChangedListener>();
  /** 坏值告警每键一次:持久值损坏极少见,但读取点可能位于每次操作的边界。 */
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

  /** 注册一个设置定义;重复 key 直接抛错(启动期 fail-fast,防止定义冲突)。 */
  register<T>(definition: SettingDefinition<T>): void {
    if (this.definitions.has(definition.key)) {
      throw new Error(`Duplicate setting key: ${definition.key}`);
    }
    this.definitions.set(
      definition.key,
      definition as SettingDefinition<unknown>,
    );
  }

  /** 设置目录(供 UI):带 schema 的只读描述,按 key 排序。 */
  listDefinitions(): SettingDescriptor[] {
    return [...this.definitions.values()]
      .map(describeSetting)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  /** 按 key 查定义;未注册返回 undefined。 */
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
    // defaultValue 是全进程共享引用,克隆防止调用方改穿默认值。
    return structuredClone(definition.defaultValue);
  }

  set<T>(definition: SettingDefinition<T>, value: T): T {
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) throw new InvalidSettingValueError(definition.key);
    if (definition.group) {
      this.assertGroupValid(definition.group, { [definition.key]: parsed.data });
    }
    // 先落库后发事件:持久化失败时订阅者不得看到未生效的值。
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
    // 收集本次改动涉及的组,整组校验(组内未改动的 key 用当前值,坏值用默认兜底)。
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

  delete(definition: SettingDefinition<unknown>): void {
    this.repository.delete(definition.key);
    this.publish([definition.key]);
  }

  subscribe(listener: SettingsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 组级 refine:对组内每个 key 取"本次改动优先,否则当前持久值(坏值用默认兜底)",
   * 组装成 { [key]: 值 } 后用组 schema 校验(含跨字段约束)。
   * 失败即拒绝,不落库。
   */
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
