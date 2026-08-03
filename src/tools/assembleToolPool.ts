// 按宿主当前拥有的能力，从统一注册表筛出本次 Agent 可见的工具实现。

import type { BuiltTool } from './types.js';
import type { ToolRegistry } from './registry.js';

/**
 * 从 Registry 筛出全部 requires 均已满足的工具。
 *
 * 该函数只处理通用 Tool 装配事实，不认识 Builtin、MCP、Turn 或具体业务 Port。
 * Profile、Skill 和 Subagent 必须在结果上继续做交集收窄，不能借此扩大能力。
 */
export function assembleToolPool<THostContext extends object>(
  registry: ToolRegistry,
  hostContext: THostContext,
): BuiltTool[] {
  return registry.list().filter((tool) => hasRequiredCapabilities(tool, hostContext));
}

function hasRequiredCapabilities(
  tool: BuiltTool,
  hostContext: object,
): boolean {
  for (const key of tool.requires ?? []) {
    const capability = Reflect.get(hostContext, key) as unknown;
    if (capability == null || capability === '') return false;
  }
  return true;
}
