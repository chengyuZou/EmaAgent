// 读取文本或图片文件，并维护后续编辑需要的文件状态。
// 模型说明书见 prompt.ts; 结果预算见 limits.ts; 图片分支见 imageReader.ts。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  contentHashOf,
  contextFail,
  contextOk,
  type ReadFileState,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { checkReadPathPermission } from '../shared/pathPermission.js';
import { imageMediaTypeFor, readImageFile, type FileReadImageResult } from './imageReader.js';
import {
  isNotebookPath,
  readNotebookFile,
  renderNotebookCells,
  type FileReadNotebookResult,
} from './notebookReader.js';
import { MAX_READ_LINES, MAX_RESULT_BYTES, SELECTED_BYTES_LIMIT, TEXT_WHOLE_READ_LIMIT } from './limits.js';
import { FILE_READ_DESCRIPTION, FILE_UNCHANGED_STUB, imageResultNotice } from './prompt.js';
import { readTextInRange } from './readTextInRange.js';

/** File 读取工具只取得当前 Turn 的读取状态与工作区；取消信号走 ToolInvocation。 */
interface FileReadToolContext {
  readFileState: ReadFileState;
  workspaceRoot: string;
}

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

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to the file to read.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start reading from (text files only).'),
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

/** 文本正文(cat -n); 截断事实模型可见。 */
export interface FileReadTextResult {
  type: 'file_content';
  filePath: string;
  content: string;
  totalLines: number;
  /** 应用了 offset/limit 时为 true。 */
  isPartialView: boolean;
  truncated?: true;
  truncationReason?: 'bytes';
  /** 截断后继续读取的起始行号。 */
  nextOffset?: number;
  /** 给模型的可读说明(英文)。 */
  notice?: string;
}

/** 同文件同范围同 mtime 的去重回放; 不带正文。 */
export interface FileReadUnchangedResult {
  type: 'file_unchanged';
  filePath: string;
  totalLines: number;
  isPartialView: boolean;
  truncated?: true;
}

export type FileReadResult =
  | FileReadTextResult
  | FileReadUnchangedResult
  | FileReadImageResult
  | FileReadNotebookResult;

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

export const FileReadTool = buildTool<FileReadInput, FileReadResult, FileReadToolContext>({
  id: BuiltinTools.FileRead.id,
  name: BuiltinTools.FileRead.name,
  description: FILE_READ_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultBytes: MAX_RESULT_BYTES,

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('File 读取工具需要明确的工作区。');
    }
    if (!ctx.readFileState) {
      return contextFail('File 读取工具未装配读取状态。');
    }
    return contextOk({
      readFileState: ctx.readFileState,
      workspaceRoot: ctx.workspaceRoot,
    });
  },

  checkPermissions: async (input, context, permissionContext) =>
    checkReadPathPermission({
      toolName: BuiltinTools.FileRead.name,
      path: path.resolve(context.workspaceRoot, input.file_path),
      workspaceRoot: context.workspaceRoot,
      permissionContext,
    }),

  async execute(
    input: FileReadInput,
    context: FileReadToolContext,
    invocation: ToolInvocation,
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

    // ── 图片分支: 扩展名单点判定, 分页参数对图片无意义 ─────────────────────────
    const imageMediaType = imageMediaTypeFor(fullPath);
    if (imageMediaType) {
      if (offset !== undefined || limit !== undefined) {
        throw new Error('offset/limit do not apply to image files.');
      }
      return readImageFile({
        fullPath,
        displayPath: file_path,
        mediaType: imageMediaType,
        sizeBytes: stat.size,
        signal: invocation.signal,
      });
    }

    // ── Notebook 分支: .ipynb 是 JSON, 映射为 cells(含输出), 不走文本分支 ──
    if (isNotebookPath(fullPath)) {
      if (offset !== undefined || limit !== undefined) {
        throw new Error('offset/limit do not apply to notebook files.');
      }
      return readNotebookFile({
        fullPath,
        displayPath: file_path,
        sizeBytes: stat.size,
        signal: invocation.signal,
      });
    }

    // 内容级二进制探测: 扩展名伪装(.exe 改名 .txt)在前 8KB 的 NUL/不可打印
    // 字符面前无效。
    if (isBinaryContent(fullPath)) {
      throw new Error(`File appears to be binary (NUL or non-printable content): ${fullPath}`);
    }
    const isPartialView = offset !== undefined || limit !== undefined;

    if (stat.size > TEXT_WHOLE_READ_LIMIT && !isPartialView) {
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
      return {
        type: 'file_unchanged',
        filePath: file_path,
        totalLines,
        isPartialView,
        ...(existing.truncated ? { truncated: true as const } : {}),
      };
    }

    // ── 读文件(小文件快路径整读, 大文件流式只留选中行) ─────────────────────────
    const result = await readTextInRange(fullPath, stat, startLine, limit, invocation.signal);

    if (result.totalLines === 0 || startLine > result.totalLines) {
      throw new Error(
        `Offset ${startLine} is beyond the end of ${fullPath} (${result.totalLines} lines).`,
      );
    }

    const content = formatWithLineNumbers(result.lines, startLine);

    // ── 更新去重缓存 ──────────────────────────────────────────────────────────
    // 整读存完整原文(FileEdit 防覆盖需要);分页只存选中切片(Edit 拒绝局部视图,
    // 缓存仅供去重回放),不再整文件占内存。contentHash 是外部修改检测的指纹。
    if (isPartialView) {
      context.readFileState.set(fullPath, {
        content: result.lines.join('\n'),
        contentHash: contentHashOf(result.lines.join('\n')),
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
        contentHash: contentHashOf(result.raw ?? result.lines.join('\n')),
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

  mapResultToModelContent(output) {
    switch (output.type) {
      case 'file_unchanged':
        return FILE_UNCHANGED_STUB;
      case 'image_content':
        return [
          {
            type: 'text',
            text: imageResultNotice(output.filePath, output.mediaType, output.originalBytes),
          },
          { type: 'image_data', data: output.base64, mimeType: output.mediaType },
        ];
      case 'notebook_content':
        return renderNotebookCells(output.cells);
      case 'file_content': {
        const notice = output.notice ? `\n${output.notice}` : '';
        return `${output.content}${notice}`;
      }
    }
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
