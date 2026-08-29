// 把气泡内容归纳成工作区展示：连续工具分组、动词摘要、当前动作（流式）、失败计数、
// 正文切分与已编辑文件汇总。行只引用真实对象（历史块 + 索引配对的结果信封 / 流式项），
// 不建第二套字段；纯函数，供渲染与测试。
import type { AssistantBlock, ToolResultBlock } from '@ema-agent/session';
import { BuiltinTools } from '@ema-agent/tools';
import { asFileEditResult, asFileWriteResult } from '@ema-agent/builtin-tools/ui';
import type { StreamItem } from '../state/messages.js';

/** 工作区行：历史路径引用持久块（工具行经 toolResultIndex 配对），流式路径引用瞬态项。 */
export type WorkRow =
  | { readonly source: 'history'; readonly block: AssistantBlock; readonly toolResult?: ToolResultBlock }
  | { readonly source: 'stream'; readonly item: StreamItem };

export type ToolWorkRow =
  | {
      readonly source: 'history';
      readonly block: Extract<AssistantBlock, { type: 'tool_use' }>;
      readonly toolResult?: ToolResultBlock;
    }
  | { readonly source: 'stream'; readonly item: Extract<StreamItem, { type: 'tool_use' }> };

// ── 行读取（本文件是工作区展示的唯一装配点） ─────────────────────────────────

export function isToolRow(row: WorkRow): row is ToolWorkRow {
  return row.source === 'history' ? row.block.type === 'tool_use' : row.item.type === 'tool_use';
}

export function isTextRow(row: WorkRow): boolean {
  return row.source === 'history' ? row.block.type === 'text' : row.item.type === 'text';
}

export function toolName(row: ToolWorkRow): string {
  return row.source === 'history' ? row.block.name : row.item.name;
}

export function toolArgs(row: ToolWorkRow): unknown {
  return row.source === 'history' ? row.block.args : row.item.args;
}

/** 行身份：历史是 tool_use.id，流式是事件的 callId——同一物理调用在后端两个边界的拼写。 */
export function toolRowId(row: ToolWorkRow): string {
  return row.source === 'history' ? row.block.id : row.item.callId;
}

/** 工具的类型化输出（TOutput）：历史来自结果信封的 data，流式来自事件 output。 */
export function toolOutput(row: ToolWorkRow): unknown {
  return row.source === 'history' ? row.toolResult?.data : row.item.output;
}

/** 失败事实：历史看结果信封的 isError/errorCode，流式看事件的 error。 */
export function toolFailure(row: ToolWorkRow): { code: string; message: string } | null {
  if (row.source === 'stream') return row.item.error ?? null;
  const result = row.toolResult;
  if (!result?.isError) return null;
  return {
    code: result.errorCode ?? 'tool/error',
    message: typeof result.content === 'string' ? result.content : '工具执行失败',
  };
}

export function toolDurationMs(row: ToolWorkRow): number | undefined {
  return row.source === 'history' ? row.toolResult?.durationMs : row.item.durationMs;
}

export function toolPermissionPending(row: ToolWorkRow): boolean {
  return row.source === 'stream' && row.item.permissionPending === true;
}

/** 是否仍在运行（无输出且无失败）；历史缺结果的行是中断残留，不算运行中。 */
export function toolRunning(row: ToolWorkRow, streaming: boolean): boolean {
  if (row.source !== 'stream' || !streaming) return false;
  return row.item.output === undefined && row.item.error === undefined;
}

// ── 分组：连续 tool_use 收为一组 ─────────────────────────────────────────────

export type WorkRowGroup =
  | { kind: 'tool_group'; rows: ToolWorkRow[] }
  | { kind: 'single'; row: WorkRow };

export function groupWorkRows(rows: readonly WorkRow[]): WorkRowGroup[] {
  const out: WorkRowGroup[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!row) break;
    if (isToolRow(row)) {
      const group: ToolWorkRow[] = [];
      while (i < rows.length) {
        const cur = rows[i];
        if (!cur || !isToolRow(cur)) break;
        group.push(cur);
        i++;
      }
      const first = group[0];
      if (group.length === 1 && first) out.push({ kind: 'single', row: first });
      else out.push({ kind: 'tool_group', rows: group });
    } else {
      out.push({ kind: 'single', row });
      i++;
    }
  }
  return out;
}

// ── 正文切分：末尾连续的 text 组是"回答"，之前的全部是可折叠的工作区 ──────────

export function splitWorkAnswer(groups: readonly WorkRowGroup[]): {
  work: WorkRowGroup[];
  answer: WorkRowGroup[];
} {
  let answerStart = groups.length;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (group?.kind === 'single' && isTextRow(group.row)) {
      answerStart = i;
    } else {
      break;
    }
  }
  return {
    work: groups.slice(0, answerStart),
    answer: groups.slice(answerStart),
  };
}

// ── 动词归类与摘要 ────────────────────────────────────────────────────────────

const COMMAND_TOOLS = new Set<string>([
  BuiltinTools.Bash.name,
  BuiltinTools.PowerShell.name,
  BuiltinTools.ProcessList.name,
  BuiltinTools.ProcessOutput.name,
  BuiltinTools.ProcessStop.name,
]);
const FILE_EDIT_TOOLS = new Set<string>([
  BuiltinTools.FileEdit.name,
  BuiltinTools.FileWrite.name,
]);

export interface ToolTally {
  commands: number;
  fileEdits: number;
  otherTools: number;
  errors: number;
}

export function tallyTools(rows: readonly ToolWorkRow[]): ToolTally {
  const tally: ToolTally = { commands: 0, fileEdits: 0, otherTools: 0, errors: 0 };
  for (const row of rows) {
    const name = toolName(row);
    if (COMMAND_TOOLS.has(name)) tally.commands += 1;
    else if (FILE_EDIT_TOOLS.has(name)) tally.fileEdits += 1;
    else tally.otherTools += 1;
    if (toolFailure(row)) tally.errors += 1;
  }
  return tally;
}

/** 摘要行："运行了 N 个命令 · 编辑了 N 个文件 · 运行了 N 个工具"；单条给具体对象。 */
export function tallySummary(rows: readonly ToolWorkRow[], tally: ToolTally): string[] {
  const parts: string[] = [];

  const singleEdit = tally.fileEdits === 1 && rows.length === 1 ? rows[0] : null;
  const singleCommand = tally.commands === 1 && rows.length === 1 ? rows[0] : null;
  if (singleEdit) {
    const change = editedFileOf(toolOutput(singleEdit));
    if (change) {
      parts.push(
        `${change.created ? '已创建' : '已编辑'} ${basename(change.path)} +${change.additions} -${change.deletions}`,
      );
      return parts;
    }
  }
  if (singleCommand) {
    const command = stringArg(toolArgs(singleCommand), 'command');
    if (command) return [`运行了 ${truncate(command, 60)}`];
  }

  if (tally.commands > 0) parts.push(`运行了 ${tally.commands} 个命令`);
  if (tally.fileEdits > 0) parts.push(`编辑了 ${tally.fileEdits} 个文件`);
  if (tally.otherTools > 0) parts.push(`运行了 ${tally.otherTools} 个工具`);
  return parts;
}

// ── 当前动作（流式直播，现在进行时）────────────────────────────────────────────

export type LiveAction =
  | { kind: 'editing'; file: string }
  | { kind: 'command'; command: string }
  | { kind: 'tool'; name: string }
  | { kind: 'waiting' };

/** 流式期间的当前动作：最后一个无结果无错误的工具行即进行中；否则在等模型。 */
export function liveAction(rows: readonly WorkRow[], streaming: boolean): LiveAction | null {
  if (!streaming) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (!isToolRow(row)) return { kind: 'waiting' };
    if (!toolRunning(row, streaming)) return { kind: 'waiting' };
    const name = toolName(row);
    if (FILE_EDIT_TOOLS.has(name)) {
      return { kind: 'editing', file: basename(stringArg(toolArgs(row), 'file_path')) };
    }
    if (name === BuiltinTools.Bash.name || name === BuiltinTools.PowerShell.name) {
      return { kind: 'command', command: truncate(stringArg(toolArgs(row), 'command'), 60) };
    }
    return { kind: 'tool', name };
  }
  return { kind: 'waiting' };
}

export function liveActionLabel(action: LiveAction): string {
  switch (action.kind) {
    case 'editing':  return `正在编辑 ${action.file}`;
    case 'command':  return `正在执行命令:${action.command}`;
    case 'tool':     return `正在运行 ${action.name}`;
    case 'waiting':  return '正在等待模型响应…';
  }
}

// ── 已编辑文件汇总（变更卡）────────────────────────────────────────────────────

export interface EditedFileEntry {
  path: string;
  additions: number;
  deletions: number;
  created: boolean;
}

export function editedFiles(rows: readonly WorkRow[]): {
  files: EditedFileEntry[];
  additions: number;
  deletions: number;
} {
  // 同一文件多次编辑只留最后一次（与 Review 的按调用归并同语义）。
  const byPath = new Map<string, EditedFileEntry>();
  for (const row of rows) {
    if (!isToolRow(row)) continue;
    const change = editedFileOf(toolOutput(row));
    if (!change) continue;
    byPath.set(change.path, {
      path: change.path,
      additions: change.additions,
      deletions: change.deletions,
      created: change.created,
    });
  }
  const files = [...byPath.values()];
  return {
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

interface TypedEditedFile {
  path: string;
  additions: number;
  deletions: number;
  created: boolean;
}

/** 从 FileEdit/FileWrite 的类型化输出提取编辑事实。 */
function editedFileOf(output: unknown): TypedEditedFile | null {
  const write = asFileWriteResult(output);
  if (write) {
    if (write.type === 'created') {
      const lines = write.content.length === 0 ? 0 : write.content.split('\n').length;
      return { path: write.filePath, additions: lines, deletions: 0, created: true };
    }
    const counts = countPatchLines(write.structuredPatch);
    return { path: write.filePath, additions: counts.additions, deletions: counts.deletions, created: false };
  }

  const edit = asFileEditResult(output);
  if (edit) {
    const counts = countPatchLines(edit.structuredPatch);
    return { path: edit.filePath, additions: counts.additions, deletions: counts.deletions, created: false };
  }
  return null;
}

/** structuredPatch 的 lines 以 ' '/'-'/'+' 开头，逐行计数即增删行数。 */
function countPatchLines(hunks: readonly { readonly lines: readonly string[] }[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

function stringArg(args: unknown, key: string): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function basename(path: string): string {
  const unified = path.replaceAll('\\', '/');
  return unified.split('/').pop() ?? path;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 时间戳：当年 M月D日 HH:mm，跨年 YYYY年M月D日。 */
export function formatTurnTime(createdAt: number, now = Date.now()): string {
  const date = new Date(createdAt);
  const current = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (date.getFullYear() !== current.getFullYear()) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 时长：秒以下显示秒，否则 Xm Ys；超过一小时带小时。 */
export function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}
