export type SettingValueKind = 'boolean' | 'number' | 'string' | 'enum' | 'object';

export type SettingApplyPolicy =
  | 'immediate'
  | 'nextOperation'
  | 'nextTurn'
  | 'restart';

export type SettingDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false };

export interface SettingDefinition<T> {
  /** 稳定业务键，也是 SQLite settings 表的主键。 */
  readonly key: string;
  /** 供设置界面选择控件；实际类型仍由 decode 校验。 */
  readonly kind: SettingValueKind;
  /** 告诉调用方新值何时进入业务，不参与持久化。 */
  readonly apply: SettingApplyPolicy;
  readonly defaultValue: T;
  decode(value: unknown): SettingDecodeResult<T>;
  /** 把类型化值转成持久化形状;缺省恒等——值本就是 JSON 原生形状时无需声明。 */
  encode?(value: T): unknown;
}

export interface SettingDescriptor {
  key: string;
  kind: SettingValueKind;
  apply: SettingApplyPolicy;
}

export function defineSetting<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  return definition;
}

export function describeSetting<T>(definition: SettingDefinition<T>): SettingDescriptor {
  return {
    key: definition.key,
    kind: definition.kind,
    apply: definition.apply,
  };
}
