// 把已校验主题设置投影为前端可应用的 CSS 变量，不直接操作 DOM。

import { InvalidThemeValueError } from './errors.js';
import type {
  ThemeMode,
  ThemeSettings,
  ThemeVariables,
} from './types.js';

export function buildThemeVariables(
  settings: ThemeSettings,
  resolvedMode: ThemeMode = settings.mode,
): ThemeVariables {
  if (!Number.isFinite(settings.hue) || settings.hue < 0 || settings.hue > 360) {
    throw new InvalidThemeValueError('hue', settings.hue);
  }
  if (!Number.isFinite(settings.radius) || settings.radius < 0 || settings.radius > 3) {
    throw new InvalidThemeValueError('radius', settings.radius);
  }
  return {
    colorScheme: resolvedMode,
    cssVariables: {
      '--chromatic-hue': String(settings.hue),
      '--ema-radius': String(settings.radius),
    },
  };
}
