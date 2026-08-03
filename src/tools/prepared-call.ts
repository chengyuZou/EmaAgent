// 这里定义一次工具调用完成解析和规范化后、进入权限检查前的不可变快照。
import type { ToolPermissionMeta } from '@ema-agent/permission';
import type { ToolOrigin } from './types.js';

/** 递归只读视图；运行时由 prepareToolInput() 对应地深冻结。 */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

/**
 * 已完成 Schema 解析的工具调用快照。
 *
 * 它是 PermissionEngine 与实际执行共同观察的唯一输入。调用方不能自行构造
 * 一个可执行快照；ToolRegistry.execute() 只接受由同一个 Registry.prepare()
 * 创建、且绑定准备时可执行 Manifest 实现的对象。
 */
export interface PreparedToolCall<TInput = unknown> {
  readonly id: string;
  readonly name: string;
  readonly origin: ToolOrigin;
  readonly summary?: string;
  readonly input: DeepReadonly<TInput>;
  readonly permissionMeta: ToolPermissionMeta;
  readonly isReadOnly: boolean;
  readonly isConcurrencySafe: boolean;
  readonly requiresUserInteraction: boolean;
  readonly maxResultBytes: number;
}

/**
 * Zod 已经复制了模型输入；这里再建立运行时不可变边界，防止 Hook、权限回调
 * 或工具调度代码在审批后原地修改嵌套参数。
 */
export function freezePreparedInput<T>(value: T): DeepReadonly<T> {
  return freezeValue(value, new WeakSet<object>()) as DeepReadonly<T>;
}

function freezeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) freezeValue(item, seen);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      freezeValue(Reflect.get(value, key), seen);
    }
  }

  return Object.freeze(value);
}
