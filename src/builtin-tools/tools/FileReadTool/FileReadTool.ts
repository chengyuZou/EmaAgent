// 按格式读取本地文件, 仅文本分支维护后续编辑需要的文件状态.
// 模型说明书见 prompt.ts; 结果预算见 limits.ts; 图片分支见 imageReader.ts。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CallVision } from '@ema-agent/vision';
import { readPdfFile, renderPdfContent, type PdfReadResult } from './pdfReader.js';
import { filePathToRuleContent } from '@ema-agent/permission';
import {
  buildTool,
  contextFail,
  contextOk,
  type FileStateCache,
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
import {
  DEFAULT_PDF_PAGE_COUNT,
  MAX_PDF_PAGE_COUNT,
  PDF_RESULT_BYTES_LIMIT,
  MAX_READ_LINES,
  MAX_RESULT_BYTES,
  SELECTED_BYTES_LIMIT,
  TEXT_WHOLE_READ_LIMIT,
} from './limits.js';
import { FILE_READ_DESCRIPTION, imageResultNotice } from './prompt.js';
import { readTextInRange, selectTextRange, type TextRangeResult } from './readTextInRange.js';

interface FileReadToolContext {
  fileStateCache: FileStateCache;
  cwd: string;
  vision?: CallVision;
}

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
  start_page: z.number().int().min(1).optional().describe('1-based first page (PDF only).'),
  page_count: z.number().int().min(1).max(MAX_PDF_PAGE_COUNT).optional()
    .describe(`Number of PDF pages to read, up to ${MAX_PDF_PAGE_COUNT}; defaults to ${DEFAULT_PDF_PAGE_COUNT}.`),
}).strict();

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

export type FileReadResult =
  | FileReadTextResult
  | FileReadImageResult
  | FileReadNotebookResult
  | PdfReadResult;

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

function textReadResult(
  filePath: string,
  result: TextRangeResult,
  startLine: number,
  isPartialView: boolean,
): FileReadTextResult {
  const nextOffset = startLine + result.lines.length;
  return {
    type: 'file_content',
    filePath,
    content: formatWithLineNumbers(result.lines, startLine),
    totalLines: result.totalLines,
    isPartialView,
    ...(result.truncated
      ? {
          truncated: true as const,
          truncationReason: 'bytes' as const,
          nextOffset,
          notice: `Output truncated at ${SELECTED_BYTES_LIMIT / 1024} KB. Use offset=${nextOffset} to continue reading.`,
        }
      : {}),
  };
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileReadTool = buildTool<FileReadInput, FileReadResult, FileReadToolContext>({
  id: BuiltinTools.FileRead.id,
  name: BuiltinTools.FileRead.name,
  description: FILE_READ_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultBytes: Math.max(MAX_RESULT_BYTES, PDF_RESULT_BYTES_LIMIT),

  validateContext(ctx) {
    if (!ctx.cwd) {
      return contextFail('File 读取工具需要明确的工作区。');
    }
    if (!ctx.fileStateCache) {
      return contextFail('File 读取工具未装配读取状态。');
    }
    return contextOk({
      fileStateCache: ctx.fileStateCache,
      cwd: ctx.cwd,
      ...(ctx.vision ? { vision: ctx.vision } : {}),
    });
  },

  async checkPermissions(input, context, permissionContext) {
    const filePath = path.resolve(context.cwd, input.file_path);
    const result = checkReadPathPermission({
      toolName: BuiltinTools.FileRead.name,
      path: filePath,
      cwd: context.cwd,
      permissionContext,
    });
    if (result.behavior === 'deny') {
      return result;
    }
    return {
      ...result,
      sessionAllowRule: {
        toolName: BuiltinTools.FileRead.name,
        ruleContent: filePathToRuleContent(filePath),
      },
    };
  },

  async execute(
    input: FileReadInput,
    context: FileReadToolContext,
    invocation: ToolInvocation,
  ): Promise<FileReadResult> {
    const { file_path, offset, limit } = input;
    // 与 Permission/Write 同一基准: 相对路径按工作区解析, 不借 Core 进程 cwd。
    const fullPath = path.resolve(context.cwd, file_path);

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

    if (path.extname(fullPath).toLowerCase() === '.pdf') {
      if (offset !== undefined || limit !== undefined) {
        throw new Error('offset/limit do not apply to PDF files. Use start_page/page_count.');
      }
      // PDF 提取正文不代表二进制原文件的编辑基准, 不写入 FileStateCache.
      return readPdfFile({
        fullPath,
        filePath: file_path,
        sizeBytes: stat.size,
        startPage: input.start_page,
        pageCount: input.page_count,
      }, context.vision, invocation);
    }
    if (input.start_page !== undefined || input.page_count !== undefined) {
      throw new Error('start_page/page_count only apply to PDF files.');
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

    const existing = context.fileStateCache.get(fullPath);
    if (
      existing &&
      Math.floor(existing.timestamp) === Math.floor(mtimeMs) &&
      existing.offset === offset &&
      existing.limit === limit
    ) {
      if (!isPartialView) {
        return textReadResult(file_path, selectTextRange(existing.content, startLine, limit), startLine, false);
      }
      let lines = existing.content.split('\n');
      if (existing.content === '' && existing.truncated) {
        lines = [];
      }
      return textReadResult(file_path, {
        lines,
        totalLines: existing.totalLines,
        truncated: existing.truncated,
      }, startLine, true);
    }

    // ── 读文件(小文件快路径整读, 大文件流式只留选中行) ─────────────────────────
    const result = await readTextInRange(fullPath, stat, startLine, limit, invocation.signal);

    if (result.totalLines === 0 || startLine > result.totalLines) {
      throw new Error(
        `Offset ${startLine} is beyond the end of ${fullPath} (${result.totalLines} lines).`,
      );
    }

    // 全文缓存用于修改时间变化后的正文比对, 范围缓存只保留已返回的切片.
    if (isPartialView) {
      context.fileStateCache.set(fullPath, {
        content: result.lines.join('\n'),
        timestamp: mtimeMs,
        offset,
        limit,
        totalLines: result.totalLines,
        truncated: result.truncated,
      });
    } else {
      context.fileStateCache.set(fullPath, {
        content: result.raw ?? result.lines.join('\n'),
        timestamp: mtimeMs,
        totalLines: result.totalLines,
        truncated: result.truncated,
      });
    }
    return textReadResult(file_path, result, startLine, isPartialView);
  },

  mapResultToModelContent(output) {
    switch (output.type) {
      case 'image_content':
        return [
          {
            type: 'text',
            text: imageResultNotice(output.filePath, output.mediaType, output.originalBytes),
          },
          { type: 'image_data', data: output.base64, mimeType: output.mediaType },
        ];
      case 'pdf_content':
        return renderPdfContent(output);
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
