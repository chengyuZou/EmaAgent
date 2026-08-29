// Tool 块主组件的参数、diff 与展示目标提取辅助，纯函数不含渲染。
import { BuiltinTools, type BuiltinToolVariant } from '@ema-agent/tools/identity';
import { createPatch } from 'diff';

export const BASH_TOOLS = new Set<string>([
  BuiltinTools.Bash.name,
  BuiltinTools.PowerShell.name,
]);
const EDIT_TOOLS = new Set<string>([BuiltinTools.FileEdit.name]);

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

export function getBashCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  return typeof a.command === 'string' ? a.command : '';
}

export function buildBodyText(
  name: string,
  args: unknown,
  output: unknown,
  editDiff: string | null,
  bashCmd: string | null,
  bashResultStr: string | null,
  argsReady: boolean,
): string {
  // 复制时保留完整 JSON（含 {}）—— 复制粘贴场景需要可解析的结构化数据
  if (BASH_TOOLS.has(name)) {
    const parts: string[] = [];
    if (bashCmd) parts.push(`$ ${bashCmd}`);
    if (bashResultStr !== null) parts.push('', bashResultStr);
    return parts.join('\n');
  }
  if (editDiff) return editDiff;
  const parts: string[] = [];
  if (argsReady) parts.push(formatJson(args));
  if (output !== undefined && output !== null) parts.push(formatJson(output));
  return parts.join('\n\n');
}

export function buildEditDiff(name: string, args: unknown): string | null {
  if (!EDIT_TOOLS.has(name) || !args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const oldStr = typeof a.old_string === 'string' ? a.old_string : null;
  const newStr = typeof a.new_string === 'string' ? a.new_string : null;
  if (oldStr === null || newStr === null) return null;
  const filePath = typeof a.file_path === 'string' ? a.file_path : 'file';
  return createPatch(filePath, oldStr, newStr, '', '', { context: 3 });
}

export function getPrimaryTarget(name: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const path = str(a.file_path);

  if ((name === BuiltinTools.FileRead.name || name === BuiltinTools.FileWrite.name) && path) return path;
  if (EDIT_TOOLS.has(name) && path) return path;
  if (name === BuiltinTools.Glob.name) return str(a.pattern);

  if (name === BuiltinTools.Grep.name) {
    const pattern = str(a.pattern);
    const searchPath = str(a.path);
    return searchPath ? `${pattern} in ${searchPath}` : pattern;
  }

  if (BASH_TOOLS.has(name)) {
    const cmd = str(a.command);
    return (cmd.split('\n')[0] ?? '').slice(0, 60);
  }

  if (name === BuiltinTools.WebSearch.name) return str(a.query);
  if (name === BuiltinTools.WebFetch.name) return str(a.url);

  const first = Object.values(a).find(v => typeof v === 'string' && v.length > 0);
  return first ? String(first).slice(0, 60) : null;
}

export function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

// ── Bash 结果守卫(data 槽形状;presentation 通道已删) ──────────────────────────

/** Bash 转交后台的引用结果；其他结果不匹配时返回 null。 */
export function asBashProcessReference(result: unknown): {
  backgroundProcessId: string;
  status: 'queued' | 'running';
} | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r['kind'] !== 'processReference' || typeof r['backgroundProcessId'] !== 'string') return null;
  const status = r['status'];
  return {
    backgroundProcessId: r['backgroundProcessId'],
    status: status === 'queued' ? 'queued' : 'running',
  };
}

/** Bash 命令结果 → 终端视图文本;非该形状返回 null(调用方回落 formatJson)。 */
export function bashCommandOutputText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r['kind'] !== 'commandResult') return null;
  const parts: string[] = [];
  if (typeof r['stdout'] === 'string' && r['stdout'].trim()) parts.push(r['stdout'].trimEnd());
  if (typeof r['stderr'] === 'string' && r['stderr'].trim()) parts.push(`[stderr]\n${r['stderr'].trimEnd()}`);
  if (typeof r['note'] === 'string' && r['note']) parts.push(r['note']);
  return parts.join('\n');
}
