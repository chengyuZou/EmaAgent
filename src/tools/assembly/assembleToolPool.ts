// 从进程 Tool 库筛选并稳定排序，建立当前根 Turn 的冻结 ToolPool。
import type { Tool } from '../Tool/tool.js';
import type { ToolUseContext } from '../Tool/toolUseContext.js';
import { ToolPool } from './toolPool.js';
import type { ToolRegistry } from './toolRegistry.js';

// 根 Pool 同时容纳不同泛型实参的 Tool。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/**
 * validateContext 是装配可见性与执行前能力复核的唯一规则。
 * Builtin 构成稳定前缀，MCP 按原始 Server/Tool 身份构成稳定后缀。
 */
export function assembleToolPool(
  registry: ToolRegistry,
  context: ToolUseContext,
): ToolPool {
  const visible = registry.list()
    .filter((tool) => tool.validateContext(context).valid)
    .sort(compareTools);
  return new ToolPool(visible);
}

function compareTools(left: AnyTool, right: AnyTool): number {
  if (left.origin.kind !== right.origin.kind) {
    return left.origin.kind === 'builtin' ? -1 : 1;
  }
  if (left.origin.kind === 'builtin' || right.origin.kind === 'builtin') {
    return compareText(left.id, right.id) || compareText(left.name, right.name);
  }
  return compareText(left.origin.serverName, right.origin.serverName)
    || compareText(left.origin.serverToolName, right.origin.serverToolName)
    || compareText(left.name, right.name)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
