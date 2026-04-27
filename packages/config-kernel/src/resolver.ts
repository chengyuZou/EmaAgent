/**
 * 配置合并与解析器。
 *
 * @remarks
 * 采用"右侧覆盖左侧"的深度合并策略。
 * 空对象 `{}` 与 `undefined` 视为"未设置"，不会覆盖已有值。
 */

import type { AppConfig } from "./schema.js";
import { DEFAULT_APP_CONFIG } from "./defaults.js";
import { loadProjectConfig, loadSessionOverrides, loadUserConfig } from "./loader.js";

/**
 * 深度合并两个普通对象，跳过右侧值为 `undefined` 的字段。
 *
 * @param target - 基础对象
 * @param source - 覆盖对象
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * 按优先级合并多层配置。
 *
 * @param layers - 配置层列表，优先级从低到高。默认配置会自动作为最底层。
 * @returns 合并后的完整配置
 *
 * @example
 * ```ts
 * const final = mergeConfigLayers([
 *   await loadProjectConfig(), // 项目
 *   await loadUserConfig(),    // 用户
 * ]);
 * ```
 */
export function mergeConfigLayers(layers: Partial<AppConfig>[]): AppConfig {
  const merged = { ...DEFAULT_APP_CONFIG } as unknown as Record<string, unknown>;

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;

      const existing = merged[key];
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing)
      ) {
        merged[key] = deepMerge(
          existing as Record<string, unknown>,
          value as unknown as Record<string, unknown>,
        );
      } else {
        merged[key] = value;
      }
    }
  }

  return merged as unknown as AppConfig;
}

/**
 * 解析指定会话的最终生效配置。
 *
 * @param sessionId - 会话 ID
 */
export async function resolveConfigForSession(sessionId: string): Promise<AppConfig> {
  const layers = await Promise.all([
    loadProjectConfig(),
    loadUserConfig(),
    loadSessionOverrides(sessionId),
  ]);

  return mergeConfigLayers(layers);
}
