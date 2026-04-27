/**
 * 工具注册中心。
 *
 * @remarks
 * 本地工具、MCP 工具、Skill 工具统一在此注册，调度层只认 `RuntimeTool`。
 */

import type { RuntimeTool } from "./tool-spec.js";

const registry = new Map<string, RuntimeTool>();

export function registerTool(tool: RuntimeTool): void {
  registry.set(tool.name, tool);
}

export function unregisterTool(toolName: string): void {
  registry.delete(toolName);
}

export function listTools(): RuntimeTool[] {
  return Array.from(registry.values());
}

export function getTool(toolName: string): RuntimeTool | undefined {
  return registry.get(toolName);
}
