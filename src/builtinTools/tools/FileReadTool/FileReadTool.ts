// 按行读取文本文件，并维护后续编辑需要的文件状态。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type BuiltinToolContext,
  type ReadFileState,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { readTextInRange, SELECTED_BYTES_LIMIT } from './readTextInRange.js';

/** File 读取工具只取得当前 Turn 的读取状态与取消信号。 */
interface FileReadToolContext {
  readFileState: ReadFileState;
  signal: AbortSignal;
  workspaceRoot: string;
}

/** 工具级结果预算: 50KB 正文预算 + cat -n 行号开销余量, 与 reader 截断口径严格一致。 */
const MAX_RESULT_BYTES = SELECTED_BYTES_LIMIT + 16 * 1024;

// ── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 会无限阻塞进程或产生无限输出的设备路径。以这些开头的路径拒绝读取。
 */
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/console',
  '/proc/kmsg',
  '/proc/kcore',
]);

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.lib',
  '.a', '.pdb', '.class', '.pyc', '.pyo', '.wasm', '.node',
]);

const TEXT_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MiB - 超此整读拒绝, 分页走流式
/** 单次分页最多行数: 防止 limit=天文数字制造巨量输出。 */
const MAX_READ_LINES = 2000;

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to the file to read.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start reading from.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_LINES)
    .optional()
    .describe(`Maximum number of lines to read (capped at ${MAX_READ_LINES}).`),
});

type FileReadInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface FileReadResult {
  type: 'file_content' | 'file_unchanged';
  filePath: string;
  /** type === 'file_content' 时存在。cat -n 格式。 */
  content?: string;
  totalLines?: number;
  /** 应用了 offset/limit 时为 true。 */
  isPartialView?: boolean;
  /** 选中内容超过字节预算被截断(模型可见, 不只是前端)。 */
  truncated?: boolean;
  truncationReason?: 'bytes';
  /** 截断后继续读取的起始行号。 */
  nextOffset?: number;
  /** 给模型的可读说明(英文)。 */
  notice?: string;
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function isBlockedDevice(p: string): boolean {
  // 统一分隔符再比较: Windows 的 path.normalize 会把 / 转成 \, 字符串判据不能跟着歪。
  const normalized = path.normalize(p).replace(/\\/g, '/');
  for (const blocked of BLOCKED_DEVICE_PATHS) {
    if (normalized === blocked || normalized.startsWith(blocked + '/')) return true;
  }
  return false;
}

export { isBlockedDevice };

function isBinaryExtension(p: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/** Windows UNC 路径(\\server\share)- 跳过以防 SMB 凭证泄露。 */
function isUncPath(p: string): boolean {
  return p.startsWith('\\\\');
}

/**
 * 内容级二进制探测: 读前 8KB, 含 NUL 字节或超过 30% 不可打印控制字符
 * (允许 \t \n \r)即判二进制。UTF-8 多字节字符不受影响。
 */
function isBinaryContent(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false; // 打不开交给后续读取统一报错
  }
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    let suspicious = 0;
    for (let i = 0; i < bytesRead; i++) {
      const b = buffer[i]!;
      if (b === 0) return true;
      if (b < 8 || (b > 13 && b < 32)) suspicious++;
    }
    return bytesRead > 0 && suspicious / bytesRead > 0.3;
  } finally {
    fs.closeSync(fd);
  }
}

/** 把内容格式化为 cat -n 输出(1 起行号)。 */
function formatWithLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`)
    .join('\n');
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileReadTool = buildTool<FileReadInput, FileReadResult, BuiltinToolContext, FileReadToolContext>({
  id: BuiltinTools.FileRead.id,
  name: BuiltinTools.FileRead.name,
  description: `Read a file from the local filesystem.

- Returns content with 1-based line numbers (cat -n format).
- Use \`offset\` and \`limit\` to paginate large files (limit up to ${MAX_READ_LINES} lines); omit both to read the entire file. Pagination streams the file — reading a slice of a huge file does not load it into memory.
- Each read returns at most ${SELECTED_BYTES_LIMIT / 1024} KB of content; larger selections are truncated with a \`nextOffset\` to continue from.
- Binary files, device files, and files over 10 MiB (without pagination) are refused.
- If the same file+range is read twice without the file changing, returns \`file_unchanged\` to save tokens.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultBytes: MAX_RESULT_BYTES,

  requires: ['workspaceRoot', 'readFileState'],

  validateContext(ctx) {
    if (!ctx.workspaceRoot || !ctx.readFileState) {
      return contextFail('File 读取工具未装配完整的工作区或读取状态。');
    }
    return contextOk({
      readFileState: ctx.readFileState,
      signal: ctx.signal,
      workspaceRoot: ctx.workspaceRoot,
    });
  },

  getPermissionIntent: (input) => ({
    riskLevel: 'low',
    accessType: 'read',
    targets: [{ path: input.file_path, accessType: 'read' }],
    promptPolicy: 'whenRequired',
  }),

  async execute(
    input: FileReadInput,
    context: FileReadToolContext,
  ): Promise<FileReadResult> {
    const { file_path, offset, limit } = input;
    // 与 Permission/Write 同一基准: 相对路径按工作区解析, 不借 Core 进程 cwd。
    const fullPath = path.resolve(context.workspaceRoot, file_path);

    // ── I/O 前校验 ────────────────────────────────────────────────────────────
    if (isUncPath(fullPath)) {
      throw new Error(`UNC paths are not supported: ${fullPath}`);
    }
    if (isBlockedDevice(fullPath)) {
      throw new Error(`Reading from device file is not allowed: ${fullPath}`);
    }
    if (isBinaryExtension(fullPath)) {
      throw new Error(
        `Binary files cannot be read as text (${path.extname(fullPath)}). ` +
          `Use a dedicated tool for binary content.`,
      );
    }

    // ── Stat + 存在性检查 ────────────────────────────────────────────────────
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      const suggestion = findSimilarFile(fullPath);
      const hint = suggestion ? ` Did you mean: ${suggestion}?` : '';
      throw new Error(`File not found: ${fullPath}.${hint}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${fullPath}`);
    }
    // 内容级二进制探测: 扩展名伪装(.exe 改名 .txt)在前 8KB 的 NUL/不可打印
    // 字符面前无效, 与 Claude 同款判定。
    if (isBinaryContent(fullPath)) {
      throw new Error(`File appears to be binary (NUL or non-printable content): ${fullPath}`);
    }
    const isPartialView = offset !== undefined || limit !== undefined;

    if (stat.size > TEXT_SIZE_LIMIT && !isPartialView) {
      throw new Error(
        `File is too large to read as text (${(stat.size / 1024 / 1024).toFixed(1)} MiB > 10 MiB). ` +
          `Use offset/limit to read a section.`,
      );
    }

    const mtimeMs = stat.mtimeMs;
    const startLine = offset ?? 1;

    // ── 去重检查: 同文件同范围同 mtime 直接回放 ───────────────────────────────
    const existing = context.readFileState.get(fullPath);
    if (
      existing &&
      existing.timestamp === mtimeMs &&
      existing.offset === offset &&
      existing.limit === limit
    ) {
      const cachedLines = existing.content.split('\n');
      // 判别联合: 两个分支都带截断事实, 回放原样保留(分页分支另有 totalLines)。
      const totalLines = existing.isPartialView ? existing.totalLines : cachedLines.length;
      const truncated = existing.truncated;
      return {
        type: 'file_unchanged',
        filePath: file_path,
        totalLines,
        isPartialView,
        ...(truncated ? { truncated: true as const } : {}),
      };
    }

    // ── 读文件(小文件快路径整读, 大文件流式只留选中行) ─────────────────────────
    const result = await readTextInRange(fullPath, stat, startLine, limit, context.signal);

    if (result.totalLines === 0 || startLine > result.totalLines) {
      throw new Error(
        `Offset ${startLine} is beyond the end of ${fullPath} (${result.totalLines} lines).`,
      );
    }

    const content = formatWithLineNumbers(result.lines, startLine);

    // ── 更新去重缓存 ──────────────────────────────────────────────────────────
    // 整读存完整原文(FileEdit 防覆盖需要逐字节精确比对);
    // 分页只存选中切片(Edit 拒绝局部视图, 缓存仅供去重回放), 不再整文件占内存。
    if (isPartialView) {
      context.readFileState.set(fullPath, {
        content: result.lines.join('\n'),
        timestamp: mtimeMs,
        offset,
        limit,
        isPartialView: true,
        totalLines: result.totalLines,
        truncated: result.truncated,
      });
    } else {
      context.readFileState.set(fullPath, {
        content: result.raw ?? result.lines.join('\n'),
        timestamp: mtimeMs,
        isPartialView: false,
        truncated: result.truncated,
      });
    }
    const nextOffset = startLine + result.lines.length;
    return {
      type: 'file_content',
      filePath: file_path,
      content,
      totalLines: result.totalLines,
      isPartialView,
      // 截断必须模型可见，不能只告诉 UI 后让模型对不完整内容继续推理。
      ...(result.truncated
        ? {
            truncated: true as const,
            truncationReason: 'bytes' as const,
            nextOffset,
            notice: `Output truncated at ${SELECTED_BYTES_LIMIT / 1024} KB. Use offset=${nextOffset} to continue reading.`,
          }
        : {}),
    };
  },
});

// ── findSimilarFile ───────────────────────────────────────────────────────────

function findSimilarFile(filePath: string): string | undefined {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);

  try {
    const entries = fs.readdirSync(dir);
    // 精确大小写不敏感匹配
    const ci = entries.find((e) => e.toLowerCase() === base.toLowerCase());
    if (ci) return path.join(dir, ci);
    // 同词干,不同扩展名
    const diffExt = entries.find(
      (e) => path.basename(e, path.extname(e)).toLowerCase() === stem.toLowerCase(),
    );
    if (diffExt) return path.join(dir, diffExt);
  } catch {
    // 目录不存在 - 无建议
  }
  return undefined;
}
