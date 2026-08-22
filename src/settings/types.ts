import { z } from 'zod';

export type SettingApplyPolicy =
  | 'immediate'
  | 'nextOperation'
  | 'nextTurn'
  | 'restart';

/**
 * 单个设置的完整声明：schema 驱动校验 + 类型推导 + UI 渲染（.describe() / z.enum 选项）。
 * 持久化时值默认以 JSON 原生形状落库（repository 序列化），无需 encode。
 */
export interface SettingDefinition<T> {
  /** 稳定业务键，也是 SQLite settings 表的主键。点号前缀分组（如 `memory.maintenance.decayAfterDays`）。 */
  readonly key: string;
  /** 给普通用户看的字段标题（非空），如「关系历史活跃天数」。 */
  readonly label: string;
  /** 给前端设置页展示的中文说明（非空）；写清楚这个参数是干什么的。 */
  readonly description: string;
  /** 新值何时进入业务（UI 据此显示"立即/下轮/重启生效"）。 */
  readonly apply: SettingApplyPolicy;
  /** zod schema：单 key 校验 + 类型推导。safeParse 失败视为坏值/非法输入。 */
  readonly schema: z.ZodType<T, unknown>;
  /** 坏值回退值 + UI 显示默认。 */
  readonly defaultValue: T;
  /**
   * 逻辑组 id（可选）：有跨字段约束的多个 key 归一组，set/setMany 时整组 refine。
   * 例：`agent.limits.maxSubagents` 与 `agent.limits.maxConcurrentSubagents`
   * 各自是独立 key（独立校验/独立变更事件/独立 UI 控件），但存在跨字段约束
   * `maxConcurrentSubagents ≤ maxSubagents`——单 key 的 schema 看不到对方，
   * 必须靠 `group: 'agent.limits'` 让 SettingsStore 在写入时凑齐整组值一起验。
   * 没有跨字段约束的 key（如 memory 的衰减参数互相独立）不需要声明 group。
   */
  readonly group?: string;
}

/**
 * 设置组：表达"多个 key 之间存在跨字段约束"。
 * SettingsStore 在 set 组内某个 key、或 setMany 提交一组时，用组 schema 对整组
 * （本次改动 + 组内其余 key 的当前值，坏值用各自 defaultValue 兜底）做 refine。
 *
 * 示例（agent.limits 组）：
 * ```ts
 * const agentLimitsGroup: SettingGroup = {
 *   id: 'agent.limits',
 *   definitions: [
 *     agentLimitsMaxSubagentsSetting,
 *     agentLimitsMaxConcurrentSubagentsSetting,
 *   ],
 *   schema: z.object({
 *     'agent.limits.maxSubagents': z.number(),
 *     'agent.limits.maxConcurrentSubagents': z.number(),
 *   }).refine(
 *     g => g['agent.limits.maxConcurrentSubagents'] <= g['agent.limits.maxSubagents'],
 *     { message: 'maxConcurrentSubagents 不能大于 maxSubagents' },
 *   ),
 * };
 * ```
 * 用户把 maxSubagents 改成 2 而 maxConcurrentSubagents 仍是 4 时，
 * 单 key 校验看不到对方，靠这里整组 refine 拦截。
 */
export interface SettingGroup {
  readonly id: string;
  /** 组内各 key 的完整定义（含 defaultValue，用于组装时兜底）。 */
  readonly definitions: readonly SettingDefinition<unknown>[];
  /** 整组对象 schema（含 refine）。输入形状为 `{ [key]: 已解码值 }`。 */
  readonly schema: z.ZodType<Record<string, unknown>, unknown>;
}

/** 暴露给设置界面的只读描述：UI 从 schema 生成表单。 */
export interface SettingDescriptor {
  key: string;
  /** 前端设置页展示的字段标题。 */
  label: string;
  /** 前端设置页展示的中文说明。 */
  description: string;
  apply: SettingApplyPolicy;
  schema: z.ZodType<unknown, unknown>;
  defaultValue: unknown;
  group?: string;
}

export function defineSetting<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  if (definition.label.trim().length === 0) {
    throw new Error(`Setting label must not be empty: ${definition.key}`);
  }
  if (definition.description.trim().length === 0) {
    throw new Error(`Setting description must not be empty: ${definition.key}`);
  }
  return definition;
}

export function describeSetting<T>(definition: SettingDefinition<T>): SettingDescriptor {
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    apply: definition.apply,
    schema: definition.schema,
    defaultValue: definition.defaultValue,
    group: definition.group,
  };
}
