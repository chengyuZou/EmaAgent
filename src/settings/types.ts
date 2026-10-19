import type { z } from 'zod';

export type SettingApplyPolicy =
  | 'immediate'
  | 'nextOperation'
  | 'nextTurn'
  | 'restart';

export interface SettingDefinition<T, K extends string = string> {
  /** SQLite settings 表的业务键. 点号前缀用于组织同类设置. */
  readonly key: K;
  /** 声明新值何时使用, 由业务调用方在相应时点读取, Store 不负责调度. */
  readonly apply: SettingApplyPolicy;
  /** 同时检查写入值和数据库读出的值, 并推导业务类型. */
  readonly schema: z.ZodType<T, unknown>;
  /** 没有用户覆盖或保存值无效时使用. */
  readonly defaultValue: T;
  /** 有跨字段约束时指定组 ID, set/setMany 会检查整组新值. */
  readonly group?: string;
}

export interface SettingGroup {
  readonly id: string;
  /** 组内定义提供当前值的校验规则及缺失时的默认值. */
  readonly definitions: readonly SettingDefinition<unknown>[];
  /** 输入以完整设置 key 为属性名, 值为本次新值及组内其余字段的当前有效值. */
  readonly schema: z.ZodType<Record<string, unknown>, unknown>;
}

export function defineSetting<T, const K extends string = string>(
  definition: Omit<SettingDefinition<T, K>, 'defaultValue'> & { readonly defaultValue: NoInfer<T> },
): SettingDefinition<T, K> {
  return definition;
}
