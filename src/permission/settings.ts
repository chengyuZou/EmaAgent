// 定义 Permission 等待时间的用户可调范围与生效阶段。

import { defineSetting } from '@ema-agent/settings';

export const DEFAULT_PERMISSION_ASK_TIMEOUT_MS = 120_000;
export const MIN_PERMISSION_ASK_TIMEOUT_MS = 5_000;
export const MAX_PERMISSION_ASK_TIMEOUT_MS = 600_000;

export const permissionAskTimeoutSetting = defineSetting<number>({
  key: 'permission.askTimeoutMs',
  kind: 'number',
  apply: 'nextOperation',
  defaultValue: DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  decode(value: unknown) {
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
