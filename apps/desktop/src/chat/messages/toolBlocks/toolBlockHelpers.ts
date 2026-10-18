import { BuiltinTools, type BuiltinToolVariant } from '@ema-agent/tools/identity';


const VARIANT_BY_NAME: ReadonlyMap<string, BuiltinToolVariant> = new Map(
  Object.values(BuiltinTools).map((tool) => [tool.name, tool.variant]),
);

export type ToolVariant = BuiltinToolVariant | 'others';
/** Tool 行实际显示的终态和中间态. 这个状态不写回 Store, 只由 ToolCallBlock 的真实数据派生. */
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

/** 不足一秒显示 ms, 不足一分钟显示 s, 更长显示 m:ss. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
