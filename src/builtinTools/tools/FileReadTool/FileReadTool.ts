// 按行读取文本文件，并维护后续编辑需要的文件状态。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type {
  ToolExecutionScope,
  ToolInvocationContext,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

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

const TEXT_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MiB - 超此拒绝读取

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
    .optional()
    .describe('Maximum number of lines to read.'),
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
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function isBlockedDevice(p: string): boolean {
  const normalized = path.normalize(p);
  for (const blocked of BLOCKED_DEVICE_PATHS) {
    if (normalized === blocked || normalized.startsWith(blocked + '/')) return true;
  }
  return false;
}

function isBinaryExtension(p: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/** Windows UNC 路径(\\server\share)- 跳过以防 SMB 凭证泄露。 */
function isUncPath(p: string): boolean {
  return p.startsWith('\\\\');
}

/** 把内容格式化为 cat -n 输出(1 起行号)。 */
function formatWithLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`)
    .join('\n');
}

function getMtimeMs(filePath: string): number {
  return fs.statSync(filePath).mtimeMs;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileReadTool = buildTool<FileReadInput, FileReadResult>({
  id: BuiltinTools.FileRead.id,
  name: BuiltinTools.FileRead.name,
  description: `Read a file from the local filesystem.

- Returns content with 1-based line numbers (cat -n format).
- Use \`offset\` and \`limit\` to paginate large files; omit both to read the entire file.
- Binary files, device files, and files over 10 MiB are refused.
- If the same file+range is read twice without the file changing, returns \`file_unchanged\` to save tokens.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
    extractPath: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      return parsed.success ? parsed.data.file_path : undefined;
    },
  },

  async execute(
    input: FileReadInput,
    ctx: ToolInvocationContext,
    scope: ToolExecutionScope,
  ): Promise<FileReadResult> {
    const { file_path, offset, limit } = input;
    const fullPath = path.resolve(file_path);

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
    const isPartialView = offset !== undefined || limit !== undefined;

    if (stat.size > TEXT_SIZE_LIMIT && !isPartialView) {
      throw new Error(
        `File is too large to read as text (${(stat.size / 1024 / 1024).toFixed(1)} MiB > 10 MiB). ` +
          `Use offset/limit to read a section.`,
      );
    }

    const mtimeMs = stat.mtimeMs;

    // ── 去重检查 ───────────────────────────────────────────────────────────────
    const existing = scope.readFileState.get(fullPath);
    if (
      existing &&
      !existing.isPartialView &&
      existing.offset === offset &&
      existing.limit === limit &&
      existing.timestamp === mtimeMs
    ) {
      return { type: 'file_unchanged', filePath: file_path };
    }

    // ── 读文件 ─────────────────────────────────────────────────────────────────
    const raw = fs.readFileSync(fullPath, 'utf8');
    const allLines = raw.split('\n');
    const totalLines = allLines.length;

    const startLine = offset ?? 1;
    const endLine = limit !== undefined ? startLine + limit - 1 : totalLines;
    const slicedLines = allLines.slice(startLine - 1, endLine);
    const content = formatWithLineNumbers(slicedLines, startLine);

    // ── 更新去重缓存 ───────────────────────────────────────────────────────────
    scope.readFileState.set(fullPath, {
      content: raw,
      timestamp: mtimeMs,
      offset,
      limit,
      isPartialView,
    });
    scope.fileStateStore?.record(fullPath, { content: raw, mtimeMs, offset, limit, isPartialView });

    return {
      type: 'file_content',
      filePath: file_path,
      content,
      totalLines,
      isPartialView,
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
