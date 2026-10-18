import type { AssistantBlock } from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { asFileEditResult, asFileWriteResult } from '@ema-agent/builtin-tools/ui';
import type { AssistantOutputBlock } from '../../../stores/turn.js';
import type { ToolExecutionLog } from '../../../api/turns.js';

type ToolUseBlock = Extract<AssistantBlock, { readonly type: 'tool_use' }>;
type StreamingToolUseItem = Extract<AssistantOutputBlock, { readonly type: 'tool_use' }>;

/** 存储目录先只有执行记录, 参数和结果在展开后读取. 不把尚未读取的结果当成执行失败. */
export type ToolDisplayCall =
  | { readonly source: 'history'; readonly block: ToolUseBlock; readonly result?: ToolResult }
  | { readonly source: 'streaming'; readonly item: StreamingToolUseItem }
  | {
      readonly source: 'execution';
      readonly record: ToolExecutionLog['executions'][number];
      readonly block?: ToolUseBlock;
      readonly result?: ToolResult;
    };

export function toolName(call: ToolDisplayCall): string {
  if (call.source === 'streaming') return call.item.name;
  if (call.source === 'execution') return call.record.toolName;
  return call.block.name;
}

export function toolArgs(call: ToolDisplayCall): unknown {
  if (call.source === 'streaming') return call.item.args;
  return call.block?.args;
}

export function toolCallId(call: ToolDisplayCall): string {
  if (call.source === 'streaming') return call.item.callId;
  if (call.source === 'execution') return call.record.callId;
  return call.block.id;
}

export function toolOutput(call: ToolDisplayCall): unknown {
  return call.source === 'streaming' ? call.item.output : call.result?.data;
}

export function toolFallbackContent(call: ToolDisplayCall): unknown {
  return call.source !== 'streaming' && call.result?.data === undefined
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
  if (call.source === 'streaming') return call.item.durationMs;
  if (call.result?.durationMs !== undefined) return call.result.durationMs;
  if (call.source === 'execution' && call.record.startedAt !== undefined && call.record.completedAt !== undefined) {
    return call.record.completedAt - call.record.startedAt;
  }
  return undefined;
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

export function toolGroupSummary(tally: ToolTally): string[] {
  const parts: string[] = [];
  if (tally.commands) parts.push(`执行 ${tally.commands} 条命令`);
  if (tally.reads) parts.push(`读取 ${tally.reads} 次`);
  if (tally.searches) parts.push(`搜索 ${tally.searches} 次`);
  if (tally.fileEdits) parts.push(`编辑 ${tally.fileEdits} 次`);
  if (tally.contextQueries) parts.push(`查询上下文 ${tally.contextQueries} 次`);
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
const READ_TOOLS = new Set<string>([BuiltinTools.FileRead.name]);
const SEARCH_TOOLS = new Set<string>([BuiltinTools.Glob.name, BuiltinTools.Grep.name, BuiltinTools.WebFetch.name, BuiltinTools.WebSearch.name]);
const CONTEXT_TOOLS = new Set<string>([
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

/** 消息与 Turn 统一使用不随当前日期变化的绝对时间. */
export function formatTurnTime(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
