// 把 system/light/dark 用户偏好解析成当前窗口实际采用的明暗模式。

import type {
  ThemeMode,
  ThemePreference,
} from './types.js';

export function resolveThemeMode(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeMode {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}
