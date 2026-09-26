// 统一 History 与 Tool 的显示字段, 并计算连续 Tool Group 摘要和已编辑文件统计.

import type { AssistantBlock } from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { asFileEditResult, asFileWriteResult } from '@ema-agent/builtin-tools/ui';
import type { AssistantOutputBlock } from '../../../stores/turn.js';
import { lookupToolUI } from './toolUIRegistry.js';

type ToolUseBlock = Extract<AssistantBlock, { readonly type: 'tool_use' }>;
type StreamingToolUseItem = Extract<AssistantOutputBlock, { readonly type: 'tool_use' }>;

/** Tool UI 区分持久 Tool Use 和尚未交给 History 的流式 Tool Use. */
export type ToolDisplayCall =
  | { readonly source: 'history'; readonly block: ToolUseBlock; readonly result?: ToolResult }
  | { readonly source: 'streaming'; readonly item: StreamingToolUseItem };

export function toolName(call: ToolDisplayCall): string {
  return call.source === 'history' ? call.block.name : call.item.name;
}

export function toolArgs(call: ToolDisplayCall): unknown {
  return call.source === 'history' ? call.block.args : call.item.args;
}

export function toolCallId(call: ToolDisplayCall): string {
  return call.source === 'history' ? call.block.id : call.item.callId;
}

export function toolOutput(call: ToolDisplayCall): unknown {
  return call.source === 'history' ? call.result?.data : call.item.output;
}

export function toolFallbackContent(call: ToolDisplayCall): unknown {
  return call.source === 'history' && call.result?.data === undefined
    ? call.result?.content
    : undefined;
}

export function toolFailure(call: ToolDisplayCall): { code: string; message: string } | null {
  if (call.source === 'streaming') return call.item.error ?? null;
  const result = call.result;
  if (!result || (!result.isError && result.errorCode === undefined)) return null;
  return {
    code: result.errorCode ?? 'tool/error',
    message: typeof result.content === 'string' ? result.content : '工具执行失败',
  };
}

export function toolDurationMs(call: ToolDisplayCall): number | undefined {
  return call.source === 'history' ? call.result?.durationMs : call.item.durationMs;
}

export function toolPermissionPending(call: ToolDisplayCall): boolean {
  return call.source === 'streaming' && call.item.permissionPending === true;
}

export function toolRunning(call: ToolDisplayCall, streaming: boolean): boolean {
  return call.source === 'streaming'
    && streaming
    && (call.item.status === 'running' || call.item.status === 'awaiting_permission');
}

export function isSubagentCall(call: ToolDisplayCall): boolean {
  return toolName(call) === BuiltinTools.Subagent.name;
}

export function isAskUserCall(call: ToolDisplayCall): boolean {
  return toolName(call) === BuiltinTools.AskUser.name;
}

export interface ToolTally {
  commands: number;
  reads: number;
  searches: number;
  fileEdits: number;
  tasks: number;
  contextQueries: number;
  otherTools: number;
  errors: number;
}

export function tallyTools(calls: readonly ToolDisplayCall[]): ToolTally {
  const tally: ToolTally = {
    commands: 0,
    reads: 0,
    searches: 0,
    fileEdits: 0,
    tasks: 0,
    contextQueries: 0,
    otherTools: 0,
    errors: 0,
  };
  for (const call of calls) {
    const name = toolName(call);
    if (COMMAND_TOOLS.has(name)) tally.commands += 1;
    else if (FILE_EDIT_TOOLS.has(name)) tally.fileEdits += 1;
    else if (TASK_TOOLS.has(name)) tally.tasks += 1;
    else if (CONTEXT_TOOLS.has(name)) tally.contextQueries += 1;
    else if (READ_TOOLS.has(name)) tally.reads += 1;
    else if (SEARCH_TOOLS.has(name)) tally.searches += 1;
    else tally.otherTools += 1;
    if (toolFailure(call)) tally.errors += 1;
  }
  return tally;
}

export function toolGroupSummary(calls: readonly ToolDisplayCall[], tally = tallyTools(calls)): string[] {
  const only = calls.length === 1 ? calls[0] : undefined;
  if (only) {
    const change = editedFileOf(toolOutput(only));
    if (change) {
      return [`${change.created ? '已创建' : '已编辑'} ${basename(change.path)} +${change.additions} -${change.deletions}`];
    }
    const title = lookupToolUI(toolName(only))?.title?.(toolArgs(only));
    if (title) return [truncate(title, 60)];
  }

  const parts: string[] = [];
  if (tally.commands) parts.push(`执行 ${tally.commands} 条命令`);
  if (tally.reads) parts.push(`读取 ${tally.reads} 次`);
  if (tally.searches) parts.push(`搜索 ${tally.searches} 次`);
  if (tally.fileEdits) parts.push(`编辑 ${tally.fileEdits} 次`);
  if (tally.contextQueries) parts.push(`查询知识 ${tally.contextQueries} 次`);
  if (tally.tasks) parts.push(`更新任务 ${tally.tasks} 次`);
  if (tally.otherTools) parts.push(`其他工具 ${tally.otherTools} 次`);
  return parts;
}

export interface EditedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly created: boolean;
}

/** 同一路径多次编辑逐次累加 Tool 已返回的行数;不扫描 patch,也不冒充 Git 工作区净差异. */
export function editedFiles(calls: readonly ToolDisplayCall[]): {
  files: EditedFile[];
  additions: number;
  deletions: number;
} {
  const byPath = new Map<string, EditedFile>();
  for (const call of calls) {
    const change = editedFileOf(toolOutput(call));
    if (!change) continue;
    const current = byPath.get(change.path);
    byPath.set(change.path, current
      ? {
          path: change.path,
          additions: current.additions + change.additions,
          deletions: current.deletions + change.deletions,
          created: current.created || change.created,
        }
      : change);
  }
  const files = [...byPath.values()];
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function editedFileOf(output: unknown): EditedFile | null {
  const write = asFileWriteResult(output);
  if (write) {
    return {
      path: write.filePath,
      additions: write.additions,
      deletions: write.deletions,
      created: write.type === 'created',
    };
  }
  const edit = asFileEditResult(output);
  if (edit) {
    return {
      path: edit.filePath,
      additions: edit.additions,
      deletions: edit.deletions,
      created: false,
    };
  }
  return null;
}

const COMMAND_TOOLS = new Set<string>([
  BuiltinTools.Bash.name,
  BuiltinTools.PowerShell.name,
  BuiltinTools.ProcessList.name,
  BuiltinTools.ProcessOutput.name,
  BuiltinTools.ProcessStop.name,
]);
const FILE_EDIT_TOOLS = new Set<string>([BuiltinTools.FileEdit.name, BuiltinTools.FileWrite.name]);
const READ_TOOLS = new Set<string>([BuiltinTools.FileRead.name, BuiltinTools.PdfRead.name]);
const SEARCH_TOOLS = new Set<string>([BuiltinTools.Glob.name, BuiltinTools.Grep.name, BuiltinTools.WebFetch.name, BuiltinTools.WebSearch.name]);
const CONTEXT_TOOLS = new Set<string>([
  BuiltinTools.KnowledgeBaseSearch.name,
  BuiltinTools.NarrativeSearch.name,
  BuiltinTools.MemorySearch.name,
  BuiltinTools.MemoryRead.name,
  BuiltinTools.MemoryList.name,
]);
const TASK_TOOLS = new Set<string>([
  BuiltinTools.TodoWrite.name,
  BuiltinTools.TaskCreate.name,
  BuiltinTools.TaskGet.name,
  BuiltinTools.TaskList.name,
  BuiltinTools.TaskUpdate.name,
]);

function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() ?? path;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 消息与 Turn 统一使用不随当前日期变化的绝对时间. */
export function formatTurnTime(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
