// 把 assistant 消息的 slices 归纳成 Codex 式工作区模型:连续工具分组、动词摘要、
// 当前动作(流式)、失败计数、正文切分与已编辑文件汇总。纯函数,供渲染与测试。
import type { FileChangePresentation } from '@ema-agent/tools';
import type { AssistantSlice } from '../../stores/conversation-store.js';

type ToolUseSlice = Extract<AssistantSlice, { type: 'tool_use' }>;

// ── 分组:连续 tool_use 收为一组 ──────────────────────────────────────────────

export type SliceGroup =
  | { kind: 'tool_group'; slices: AssistantSlice[] }
  | { kind: 'single'; slice: AssistantSlice };

export function groupSlices(slices: readonly AssistantSlice[]): SliceGroup[] {
  const out: SliceGroup[] = [];
  let i = 0;
  while (i < slices.length) {
    const s = slices[i];
    if (!s) break;
    if (s.type === 'tool_use') {
      const group: AssistantSlice[] = [];
      while (i < slices.length) {
        const cur = slices[i];
        if (!cur || cur.type !== 'tool_use') break;
        group.push(cur);
        i++;
      }
      const first = group[0];
      if (group.length === 1 && first) out.push({ kind: 'single', slice: first });
      else out.push({ kind: 'tool_group', slices: group });
    } else {
      out.push({ kind: 'single', slice: s });
      i++;
    }
  }
  return out;
}

// ── 正文切分:末尾连续的 text 组是"宣告",之前的全部是可折叠的工作区 ───────────

export function splitWorkAnswer(groups: readonly SliceGroup[]): {
  work: SliceGroup[];
  answer: SliceGroup[];
} {
  let answerStart = groups.length;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (group?.kind === 'single' && group.slice.type === 'text') {
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

const COMMAND_TOOLS = new Set(['Bash', 'ProcessList', 'ProcessOutput', 'ProcessStop']);
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'ScratchpadWrite']);

export interface ToolTally {
  commands: number;
  fileEdits: number;
  otherTools: number;
  errors: number;
}

export function tallyTools(slices: readonly AssistantSlice[]): ToolTally {
  const tally: ToolTally = { commands: 0, fileEdits: 0, otherTools: 0, errors: 0 };
  for (const slice of slices) {
    if (slice.type !== 'tool_use') continue;
    if (COMMAND_TOOLS.has(slice.name)) tally.commands += 1;
    else if (FILE_EDIT_TOOLS.has(slice.name)) tally.fileEdits += 1;
    else tally.otherTools += 1;
    if (slice.error) tally.errors += 1;
  }
  return tally;
}

/** 摘要行:"运行了 N 个命令 · 编辑了 N 个文件 · 运行了 N 个工具";单条给具体对象。 */
export function tallySummary(
  slices: readonly AssistantSlice[],
  tally: ToolTally,
): string[] {
  const tools = slices.filter((s): s is ToolUseSlice => s.type === 'tool_use');
  const parts: string[] = [];

  const singleEdit = tally.fileEdits === 1 && tools.length === 1 ? tools[0] : null;
  const singleCommand = tally.commands === 1 && tools.length === 1 ? tools[0] : null;
  if (singleEdit) {
    const change = fileChangeOf(singleEdit);
    if (change) {
      parts.push(
        `${change.operation === 'create' ? '已创建' : '已编辑'} ${basename(change.filePath)} +${change.additions} -${change.deletions}`,
      );
      return parts;
    }
  }
  if (singleCommand) {
    const command = bashCommandOf(singleCommand);
    if (command) return [`运行了 ${truncate(command, 60)}`];
  }

  if (tally.commands > 0) parts.push(`运行了 ${tally.commands} 个命令`);
  if (tally.fileEdits > 0) parts.push(`编辑了 ${tally.fileEdits} 个文件`);
  if (tally.otherTools > 0) parts.push(`运行了 ${tally.otherTools} 个工具`);
  return parts;
}

// ── 当前动作(流式直播,现在进行时)────────────────────────────────────────────

export type LiveAction =
  | { kind: 'editing'; file: string }
  | { kind: 'command'; command: string }
  | { kind: 'tool'; name: string }
  | { kind: 'waiting' };

/** 流式期间的当前动作:最后一个无结果无错误的 tool_use 即进行中;否则在等模型。 */
export function liveAction(
  slices: readonly AssistantSlice[],
  streaming: boolean,
): LiveAction | null {
  if (!streaming) return null;
  for (let i = slices.length - 1; i >= 0; i -= 1) {
    const slice = slices[i];
    if (!slice) continue;
    if (slice.type !== 'tool_use') return { kind: 'waiting' };
    if (slice.result !== undefined || slice.error) return { kind: 'waiting' };
    if (FILE_EDIT_TOOLS.has(slice.name)) {
      return { kind: 'editing', file: basename(stringArg(slice, 'file_path')) };
    }
    if (slice.name === 'Bash') {
      return { kind: 'command', command: truncate(stringArg(slice, 'command'), 60) };
    }
    return { kind: 'tool', name: slice.name };
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

// ── 已编辑文件汇总(变更卡)────────────────────────────────────────────────────

export interface EditedFileEntry {
  path: string;
  additions: number;
  deletions: number;
  created: boolean;
}

export function editedFiles(slices: readonly AssistantSlice[]): {
  files: EditedFileEntry[];
  additions: number;
  deletions: number;
} {
  // 同一文件多次编辑只留最后一次(与 Review 的 byCallId 归并同语义)。
  const byPath = new Map<string, EditedFileEntry>();
  for (const slice of slices) {
    if (slice.type !== 'tool_use') continue;
    const change = fileChangeOf(slice);
    if (!change) continue;
    byPath.set(change.filePath, {
      path: change.filePath,
      additions: change.additions,
      deletions: change.deletions,
      created: change.operation === 'create',
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

function fileChangeOf(slice: ToolUseSlice): FileChangePresentation | null {
  return slice.presentation?.kind === 'file_change' ? slice.presentation : null;
}

function bashCommandOf(slice: ToolUseSlice): string | null {
  const command = stringArg(slice, 'command');
  return command || null;
}

function stringArg(slice: ToolUseSlice, key: string): string {
  const args = slice.args;
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

/** 时间戳:当年 M月D日 HH:mm,跨年 YYYY年M月D日。 */
export function formatTurnTime(createdAt: number, now = Date.now()): string {
  const date = new Date(createdAt);
  const current = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (date.getFullYear() !== current.getFullYear()) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 时长:秒以下显示秒,否则 Xm Ys;超过一小时带小时。 */
export function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}
