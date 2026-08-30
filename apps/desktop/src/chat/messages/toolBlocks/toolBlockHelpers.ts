// Tool 块的图标分组与通用回退格式化，纯函数不含渲染。
// 字段语义（主目标/复制文本/diff/结果文本）由各 Tool 自己的 UI 出口拥有，不在此猜测。
import { BuiltinTools, type BuiltinToolVariant } from '@ema-agent/tools/identity';

// ── 工具 variant：leading 槽的图标分组，身份表单点拥有；MCP/未知工具回落 others ──

const VARIANT_BY_NAME: ReadonlyMap<string, BuiltinToolVariant> = new Map(
  Object.values(BuiltinTools).map((tool) => [tool.name, tool.variant]),
);

export type ToolVariant = BuiltinToolVariant | 'others';
export type ToolDisplayStatus = 'running' | 'awaiting_permission' | 'success' | 'failed' | 'denied';

export function toolVariant(name: string): ToolVariant {
  return VARIANT_BY_NAME.get(name) ?? 'others';
}

export const VARIANT_ICONS: Readonly<Record<ToolVariant, string>> = {
  read: 'i-lucide:book-open',
  search: 'i-lucide:search',
  shell: 'i-lucide:terminal',
  edit: 'i-lucide:pencil',
  ask: 'i-lucide:message-circle-question',
  task: 'i-lucide:list-checks',
  skill: 'i-lucide:sparkles',
  agent: 'i-lucide:bot',
  others: 'i-lucide:sparkles',
};

export function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

/** 无专属 copyText 时的默认复制：args 与结果的 JSON 拼接（保留完整结构，可直接解析）。 */
export function defaultCopyText(args: unknown, output: unknown, argsReady: boolean): string {
  const parts: string[] = [];
  if (argsReady) parts.push(formatJson(args));
  if (output !== undefined && output !== null) parts.push(formatJson(output));
  return parts.join('\n\n');
}
