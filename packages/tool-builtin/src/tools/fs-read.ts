import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Device paths that would block the process indefinitely or produce infinite
 * output. Read is refused for any path that starts with one of these.
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

const TEXT_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MiB — refuse reads beyond this

// ── Input schema ──────────────────────────────────────────────────────────────

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

type FsReadInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface FsReadResult {
  type: 'file_content' | 'file_unchanged';
  filePath: string;
  /** Present when type === 'file_content'. cat -n formatted. */
  content?: string;
  totalLines?: number;
  /** True when offset/limit were applied. */
  isPartialView?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Windows UNC paths (\\server\share) — skip to prevent SMB credential leaks. */
function isUncPath(p: string): boolean {
  return p.startsWith('\\\\');
}

/** Format content as cat -n output (1-based line numbers). */
function formatWithLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`)
    .join('\n');
}

function getMtimeMs(filePath: string): number {
  return fs.statSync(filePath).mtimeMs;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const fsReadTool = buildTool<FsReadInput, FsReadResult>({
  name: 'fs_read',
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

  async execute(input: FsReadInput, ctx: ToolExecutionContext): Promise<FsReadResult> {
    const { file_path, offset, limit } = input;
    const fullPath = path.resolve(file_path);

    // ── Pre-I/O validation ────────────────────────────────────────────────────
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

    // ── Stat + existence check ────────────────────────────────────────────────
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

    // ── Dedup check ───────────────────────────────────────────────────────────
    const existing = ctx.readFileState.get(fullPath);
    if (
      existing &&
      !existing.isPartialView &&
      existing.offset === offset &&
      existing.limit === limit &&
      existing.timestamp === mtimeMs
    ) {
      return { type: 'file_unchanged', filePath: file_path };
    }

    // ── Read file ─────────────────────────────────────────────────────────────
    const raw = fs.readFileSync(fullPath, 'utf8');
    const allLines = raw.split('\n');
    const totalLines = allLines.length;

    const startLine = offset ?? 1;
    const endLine = limit !== undefined ? startLine + limit - 1 : totalLines;
    const slicedLines = allLines.slice(startLine - 1, endLine);
    const content = formatWithLineNumbers(slicedLines, startLine);

    // ── Update dedup cache ────────────────────────────────────────────────────
    ctx.readFileState.set(fullPath, {
      content: raw,
      timestamp: mtimeMs,
      offset,
      limit,
      isPartialView,
    });

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
    // Exact case-insensitive match
    const ci = entries.find((e) => e.toLowerCase() === base.toLowerCase());
    if (ci) return path.join(dir, ci);
    // Same stem, different extension
    const diffExt = entries.find(
      (e) => path.basename(e, path.extname(e)).toLowerCase() === stem.toLowerCase(),
    );
    if (diffExt) return path.join(dir, diffExt);
  } catch {
    // dir doesn't exist — no suggestion
  }
  return undefined;
}
