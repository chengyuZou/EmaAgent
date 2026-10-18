import type { Tool } from '../Tool/tool.js';
import { ToolPool } from './toolPool.js';
import type { ToolRegistry } from './toolRegistry.js';

// 根 Pool 同时容纳不同泛型实参的 Tool.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/**
 * Builtin 在前, MCP 按原始 Server/Tool 身份排序.
 * 工具开关和调用范围由调用方筛选, 执行环境在真正调用时检查.
 */
export function assembleToolPool(
  registry: ToolRegistry,
): ToolPool {
  const ordered = [...registry.list()]
    .sort(compareTools);
  return new ToolPool(ordered);
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
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
