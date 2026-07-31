// Tool 块主组件的参数、diff 与展示目标提取辅助,纯函数不含渲染。
import type { AssistantSlice } from '../../../stores/conversation-store.js';
import { createPatch } from 'diff';

// 新会话使用 PascalCase；其余名称只负责渲染升级前保存的历史消息。
export const BASH_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'powershell', 'run_command', 'execute_bash', 'shell']);
const EDIT_TOOLS = new Set(['Edit', 'edit_file', 'str_replace', 'str_replace_editor', 'apply_diff', 'patch']);

export function getBashCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  return typeof (a.command ?? a.cmd) === 'string' ? String(a.command ?? a.cmd) : '';
}

export function buildBodyText(
  slice: Extract<AssistantSlice, { type: 'tool_use' }>,
  editDiff: string | null,
  bashCmd: string | null,
  bashResultStr: string | null,
  argsReady: boolean,
): string {
  // 复制时保留完整 JSON（含 {}）—— 复制粘贴场景需要可解析的结构化数据
  if (BASH_TOOLS.has(slice.name)) {
    const parts: string[] = [];
    if (bashCmd) parts.push(`$ ${bashCmd}`);
    if (bashResultStr !== null) parts.push('', bashResultStr);
    return parts.join('\n');
  }
  if (editDiff) return editDiff;
  const parts: string[] = [];
  if (argsReady) parts.push(formatJson(slice.args));
  if (slice.result !== undefined && slice.result !== null) parts.push(formatJson(slice.result));
  return parts.join('\n\n');
}

export function buildEditDiff(name: string, args: unknown): string | null {
  if (!EDIT_TOOLS.has(name) || !args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const oldStr = typeof a.old_str === 'string' ? a.old_str
               : typeof a.old_string === 'string' ? a.old_string
               : null;
  const newStr = typeof a.new_str === 'string' ? a.new_str
               : typeof a.new_string === 'string' ? a.new_string
               : null;
  if (oldStr === null || newStr === null) return null;
  const filePath = typeof (a.path ?? a.file_path) === 'string'
    ? String(a.path ?? a.file_path) : 'file';
  return createPatch(filePath, oldStr, newStr, '', '', { context: 3 });
}

export function getPrimaryTarget(name: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const path = str(a.path ?? a.file_path ?? a.filepath ?? a.target_file ?? a.filename ?? '');

  if (['Read', 'Write', 'read', 'read_file', 'write', 'write_file', 'view'].includes(name) && path) return path;
  if (EDIT_TOOLS.has(name) && path) return path;
  if (name === 'Glob' || name === 'glob' || name === 'list_files') return str(a.pattern ?? a.glob ?? a.path ?? '');

  if (name === 'Grep' || name === 'grep' || name === 'search_files') {
    const pat = str(a.pattern ?? a.query ?? '');
    return path ? `${pat} in ${path}` : pat;
  }

  if (BASH_TOOLS.has(name)) {
    const cmd = str(a.command ?? a.cmd ?? '');
    return (cmd.split('\n')[0] ?? '').slice(0, 60);
  }

  // 旧名称只用于恢复升级前已经持久化的历史 Tool block。
  if (['WebSearch', 'web_search', 'search'].includes(name)) return str(a.query ?? '');
  if (['WebFetch', 'web_fetch', 'fetch', 'url_fetch'].includes(name)) return str(a.url ?? '');

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