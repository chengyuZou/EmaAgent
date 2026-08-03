// 定义 Permission 等待时间的用户可调范围与生效阶段。

import { defineSetting } from '@ema-agent/settings';

/** null 表示一直等待，直到用户响应或 Turn/Session 生命周期主动取消。 */
export const DEFAULT_PERMISSION_ASK_TIMEOUT_MS: null = null;
export const MIN_PERMISSION_ASK_TIMEOUT_MS = 5_000;
export const MAX_PERMISSION_ASK_TIMEOUT_MS = 600_000;

export const permissionAskTimeoutSetting = defineSetting<number | null>({
  key: 'permission.askTimeoutMs',
  kind: 'number',
  apply: 'nextOperation',
  defaultValue: DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  decode(value: unknown) {
    if (value === null) return { ok: true as const, value: null };
    return Number.isInteger(value)
      && (value as number) >= MIN_PERMISSION_ASK_TIMEOUT_MS
      && (value as number) <= MAX_PERMISSION_ASK_TIMEOUT_MS
      ? { ok: true as const, value: value as number }
      : { ok: false as const };
  },
  encode(value) {
    return value;
  },
});
