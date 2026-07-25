// 通过 ripgrep 在时间、输出和结果数量预算内搜索文件内容。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  createSearchPresentation,
  presentToolResult,
} from '@ema-agent/tools';
import type { SearchLimitReason } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';
import { runBoundedProcess } from '../shared/BoundedProcess.js';
import { sortByMtimeDesc } from '../GlobTool/GlobTool.js';

/** Grep 工具的窄 Context：工作区根 + per-call 取消信号。 */
interface GrepToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  pattern: z.string().min(1).describe(
    'Regex pattern to search for in file contents (ripgrep syntax).',
  ),
  path: z
    .string()
    .optional()
    .describe('File or directory to search. Defaults to workspace root.'),
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files, e.g. "*.ts" or "**/*.{ts,tsx}".'),
  type: z
    .string()
    .optional()
    .describe('File type to search (rg --type), e.g. "ts", "py", "rust". More convenient than glob for standard file types.'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .default('files_with_matches')
    .describe(
      'content - show matching lines with context; ' +
        'files_with_matches - show file paths only; ' +
        'count - show match count per file.',
    ),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context before and after each match (only for content mode). Takes precedence over context_before/context_after.'),
  context_before: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context before each match (rg -B, content mode only).'),
  context_after: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context after each match (rg -A, content mode only).'),
  case_insensitive: z.boolean().default(false).describe('Case-insensitive matching.'),
  multiline: z
    .boolean()
    .default(false)
    .describe('Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall).'),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(250)
    .describe('Maximum output lines / entries returned.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Skip first N lines/entries before applying head_limit (pagination).'),
});

type GrepInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface GrepResult {
  output: string;
  truncated: boolean;
  stopReason?: 'records' | 'bytes' | 'timeout';
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const GrepTool = buildTool<GrepInput, GrepResult, BuiltinToolContext, GrepToolContext>({
  id: BuiltinTools.Grep.id,
  name: BuiltinTools.Grep.name,
  description: `Regex content search powered by ripgrep.

Output modes:
- \`files_with_matches\` (default) - list file paths that contain the pattern, newest-modified first
- \`content\` - show matching lines, with optional surrounding context lines (\`context\`, or \`context_before\`/\`context_after\`)
- \`count\` - show match count per file plus a total summary

Use \`glob\` or \`type\` to restrict which files are searched (e.g. \`"*.ts"\` or \`"rust"\`).
Results are capped at \`head_limit\` output lines (default 250; in \`content\` mode this includes context lines, so fewer matches may fit). Use \`offset\` to paginate.
Over-long lines (minified/base64-style) are skipped.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel:   'low',
    accessType:  'read',
    // 同 glob 的理由:显式 path 做工作区边界检查;
    // 缺失默认 workspaceRoot(总在界内)。
    extractPath: (input) => (input as { path?: string }).path,
  },

  requires: ['workspaceRoot'],

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('Grep 工具需要明确的工作区，禁止回退到 Sidecar 进程目录。');
    }
    return contextOk({
      workspaceRoot: ctx.workspaceRoot,
      signal: ctx.signal,
    });
  },

  async execute(input: GrepInput, context: GrepToolContext): Promise<GrepResult> {
    const {
      pattern,
      path: inputPath,
      glob: globFilter,
      type: fileType,
      output_mode,
      context: contextLines,
      context_before,
      context_after,
      case_insensitive,
      multiline,
      head_limit,
      offset,
    } = input;

    const workspaceRoot = context.workspaceRoot;
    // cwd 内搜索: 输出相对路径(省 token 且更易读); 目标是文件时以其所在目录为 cwd。
    const resolvedTarget = inputPath
      ? path.resolve(workspaceRoot, inputPath)
      : workspaceRoot;
    let searchCwd = resolvedTarget;
    let searchTarget = '.';
    try {
      if (fs.statSync(resolvedTarget).isFile()) {
        searchCwd = path.dirname(resolvedTarget);
        searchTarget = path.basename(resolvedTarget);
      }
    } catch {
      // 路径不存在: 交给 rg 自己的错误输出(经下方 stderr 透传)。
    }

    const args: string[] = [];

    // 模式标志
    if (output_mode === 'files_with_matches') args.push('--files-with-matches');
    else if (output_mode === 'count') args.push('--count');
    // content 模式:rg 默认行为(显示匹配行)

    // 防止 base64/minified 单行巨行吃掉输出行数与字节预算(Claude 同款)。
    args.push('--max-columns', '500');

    if (multiline) args.push('-U', '--multiline-dotall');

    if (output_mode === 'content') {
      // -C 优先; 否则独立 -B/-A。
      if (contextLines !== undefined) {
        args.push('-C', String(contextLines));
      } else {
        if (context_before !== undefined) args.push('-B', String(context_before));
        if (context_after !== undefined) args.push('-A', String(context_after));
      }
      args.push('--line-number');
    }
    if (case_insensitive) args.push('--ignore-case');
    if (fileType) args.push('--type', fileType);
    if (globFilter) args.push('--glob', globFilter);

    args.push('--no-heading', '--color=never');
    // `--` 把模型提供的 pattern/path 与 rg 自身参数隔开，避免以 `-` 开头的内容被当成选项。
    args.push('--', pattern, searchTarget);

    let result;
    try {
      result = await runBoundedProcess('rg', args, {
        cwd: searchCwd,
        signal: context.signal,
        delimiter: '\n',
        // 需要 offset + head_limit 条再截, 保留流式早停语义。
        maxRecords: offset + head_limit,
        maxBytes: MAX_OUTPUT_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
        allowedExitCodes: [0, 1],
      });
    } catch (err: unknown) {
      // rg 是外部二进制: 缺失时给模型可执行的明确错误, 不抛裸 spawn ENOENT。
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'ripgrep (rg) is not installed or not on PATH. Grep requires the rg binary; install ripgrep and retry.',
        );
      }
      throw err;
    }

    // rg 用 cwd+相对目标输出的路径带 ./ 前缀, 剥掉再展示。
    let records = result.records.map((r) => (r.startsWith('./') ? r.slice(2) : r));

    // files_with_matches 按 mtime 降序(与 Glob 的 newest-first 对齐);
    // 排序在切片前, 否则拿到的是遍历序而不是最新序。
    if (output_mode === 'files_with_matches') {
      records = sortByMtimeDesc(records.map((r) => path.resolve(searchCwd, r)))
        .map((p) => path.relative(searchCwd, p));
    }

    const page = records.slice(offset, offset + head_limit);

    let output = page.join('\n');
    if (output_mode === 'count' && page.length > 0) {
      let totalMatches = 0;
      for (const line of page) {
        const idx = line.lastIndexOf(':');
        const n = idx > 0 ? Number.parseInt(line.slice(idx + 1), 10) : NaN;
        if (!Number.isNaN(n)) totalMatches += n;
      }
      output += `\n\nFound ${totalMatches} total occurrences across ${page.length} files.`;
    }
    if (result.truncated) {
      output += `${output ? '\n' : ''}[Search stopped at the ${result.stopReason ?? 'output'} limit. Narrow the pattern/path/glob, or continue with offset=${offset + head_limit}.]`;
    }

    return presentToolResult(
      {
        output,
        truncated: result.truncated,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      },
      createSearchPresentation({
        operation: 'content_search',
        pattern,
        searchPath: resolvedTarget,
        resultCount: page.length,
        truncated: result.truncated,
        ...(result.stopReason
          ? { limitReason: normalizeSearchLimitReason(result.stopReason) }
          : {}),
      }),
    );
  },
});

function normalizeSearchLimitReason(
  reason: 'records' | 'bytes' | 'timeout',
): SearchLimitReason {
  return reason === 'records' ? 'results' : reason;
}
