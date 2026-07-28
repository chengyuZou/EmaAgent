// 提供常见设置类型的定义助手，统一数字范围和枚举校验。

import type {
  SettingApplyPolicy,
  SettingDefinition,
} from './types.js';
import { defineSetting } from './types.js';

interface DefinitionBase<T> {
  key: string;
  apply: SettingApplyPolicy;
  defaultValue: T;
}

export function defineBooleanSetting(
  input: DefinitionBase<boolean>,
): SettingDefinition<boolean> {
  return defineSetting<boolean>({
    ...input,
    kind: 'boolean',
    decode: value => typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false },
    encode: value => value,
  });
}

export function defineNumberSetting(
  input: DefinitionBase<number> & { min: number; max: number; integer?: boolean },
): SettingDefinition<number> {
  return defineSetting<number>({
    key: input.key,
    kind: 'number',
    apply: input.apply,
    defaultValue: input.defaultValue,
    decode(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
      if (input.integer && !Number.isInteger(value)) return { ok: false };
      return value >= input.min && value <= input.max
        ? { ok: true, value }
        : { ok: false };
    },
    encode: value => value,
  });
}

export function defineEnumSetting<const T extends readonly string[]>(
  input: DefinitionBase<T[number]> & { values: T },
): SettingDefinition<T[number]> {
  const allowed = new Set<string>(input.values);
  return defineSetting<T[number]>({
    key: input.key,
    kind: 'enum',
    apply: input.apply,
    defaultValue: input.defaultValue,
    decode: value => typeof value === 'string' && allowed.has(value)
      ? { ok: true, value: value as T[number] }
      : { ok: false },
    encode: value => value,
  });
}
