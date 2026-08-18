// 通过 ripgrep 在时间、输出和结果数量预算内搜索文件内容。
// 模型说明书见 prompt.ts; rg 是外部二进制(缺失时给明确错误); 结果按模式三形态返回。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool, contextFail, contextOk, type ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { checkReadPathPermission } from '../shared/pathPermission.js';
import { runBoundedProcess } from '../shared/BoundedProcess.js';
import { sortPathsByMtimeDesc } from '../shared/fileMtimeSort.js';
import { GREP_DESCRIPTION } from './prompt.js';

/** Grep 工具的窄 Context：只取工作区根；取消信号走 ToolInvocation。 */
interface GrepToolContext {
  workspaceRoot: string;
}

const MAX_ENUMERATED_RECORDS = 20_000;
const MAX_OFFSET = 19_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
/** 版本控制元数据目录自动排除, 避免搜索结果噪声。 */
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

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
    .max(MAX_OFFSET)
    .default(0)
    .describe(`Skip first N lines/entries before applying head_limit (pagination, max ${MAX_OFFSET}).`),
});

type GrepInput = z.infer<typeof inputSchema>;

export type GrepResult =
  | {
      type: 'files_with_matches';
      /** 匹配的文件路径(相对搜索根, '/' 分隔), 按 mtime 降序。 */
      files: string[];
      truncated: boolean;
      /** 仅 truncated=true 时存在。给模型的人类可读提示。 */
      notice?: string;
    }
  | {
      type: 'count';
      /** 分页后的 "文件:计数" 行。 */
      entries: string[];
      /** 有界全集内累计的匹配总数(截断时为下限)。 */
      totalMatches: number;
      /** 参与统计的文件数。 */
      fileCount: number;
      truncated: boolean;
      notice?: string;
    }
  | {
      type: 'content';
      /** 匹配行(含行号与上下文), 已剥 ./ 前缀。 */
      output: string;
      numLines: number;
      truncated: boolean;
      notice?: string;
    };

export const GrepTool = buildTool<GrepInput, GrepResult, GrepToolContext>({
  id: BuiltinTools.Grep.id,
  name: BuiltinTools.Grep.name,
  description: GREP_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('Grep 工具需要明确的工作区，禁止回退到 Sidecar 进程目录。');
    }
    return contextOk({ workspaceRoot: ctx.workspaceRoot });
  },

  validateInput(input, context) {
    if (!input.path) return { valid: true };
    // UNC 跳过 stat: stat 本身会触发 SMB 认证, NTLM 凭据泄露; Permission 层会拦。
    if (input.path.startsWith('\\\\') || input.path.startsWith('//')) return { valid: true };
    const resolved = path.resolve(context.workspaceRoot, input.path);
    try {
      fs.statSync(resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { valid: false, message: `Path does not exist: ${input.path}` };
      }
      return { valid: false, message: `Cannot access path: ${input.path}` };
    }
    return { valid: true };
  },

  checkPermissions: async (input, context, permissionContext) =>
    checkReadPathPermission({
      toolName: BuiltinTools.Grep.name,
      path: input.path
        ? path.resolve(context.workspaceRoot, input.path)
        : context.workspaceRoot,
      workspaceRoot: context.workspaceRoot,
      permissionContext,
    }),

  async execute(
    input: GrepInput,
    context: GrepToolContext,
    invocation: ToolInvocation,
  ): Promise<GrepResult> {
    const workspaceRoot = context.workspaceRoot;
    // cwd 内搜索: 输出相对路径(省 token 且更易读); 目标是文件时以其所在目录为 cwd。
    const resolvedTarget = input.path
      ? path.resolve(workspaceRoot, input.path)
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

    let result;
    try {
      // 文件列表和计数必须先取得有界全集, 才能诚实排序、分页和统计;
      // content 仍按 offset + head_limit 流式早停, 避免无谓收集大量正文。
      const maxRecords = input.output_mode === 'content'
        ? input.offset + input.head_limit
        : MAX_ENUMERATED_RECORDS;
      result = await runBoundedProcess('rg', buildRgArgs(input, searchTarget), {
        cwd: searchCwd,
        signal: invocation.signal,
        delimiter: '\n',
        maxRecords,
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
    const records = result.records.map((r) => (r.startsWith('./') ? r.slice(2) : r));
    const pageStart = input.offset;
    const pageEnd = input.offset + input.head_limit;
    const truncated = result.truncated || pageEnd < records.length;
    const notice = truncated
      ? `[Search stopped at the ${result.stopReason ?? 'output'} limit. Use a narrower pattern/path/glob, or continue with offset=${pageEnd}.]`
      : undefined;

    switch (input.output_mode) {
      case 'files_with_matches': {
        // 按 mtime 降序(与 Glob 的 newest-first 对齐); 排序在切片前, 否则拿到的是遍历序。
        // path.relative 在 Windows 返回反斜杠, 统一 '/' 与 rg 原始输出口径一致(模型可回填)。
        const sorted = await sortPathsByMtimeDesc(
          records.map((record) => path.resolve(searchCwd, record)),
        );
        return {
          type: 'files_with_matches',
          files: sorted
            .slice(pageStart, pageEnd)
            .map((p) => path.relative(searchCwd, p).replace(/\\/g, '/')),
          truncated,
          ...(notice ? { notice } : {}),
        };
      }
      case 'count': {
        // 统计基于有界全集(截断时 "at least"); 展示按分页切片。
        let totalMatches = 0;
        for (const line of records) {
          const idx = line.lastIndexOf(':');
          const n = idx > 0 ? Number.parseInt(line.slice(idx + 1), 10) : NaN;
          if (!Number.isNaN(n)) totalMatches += n;
        }
        return {
          type: 'count',
          entries: records.slice(pageStart, pageEnd),
          totalMatches,
          fileCount: records.length,
          truncated,
          ...(notice ? { notice } : {}),
        };
      }
      default: {
        const page = records.slice(pageStart, pageEnd);
        return {
          type: 'content',
          output: page.join('\n'),
          numLines: page.length,
          truncated,
          ...(notice ? { notice } : {}),
        };
      }
    }
  },

  mapResultToModelContent(output) {
    switch (output.type) {
      case 'files_with_matches': {
        if (output.files.length === 0) return 'No files found';
        const header = `Found ${output.files.length} file${output.files.length === 1 ? '' : 's'}`;
        return output.notice
          ? `${header}\n${output.files.join('\n')}\n${output.notice}`
          : `${header}\n${output.files.join('\n')}`;
      }
      case 'count': {
        const body = output.entries.join('\n') || 'No matches found';
        const summary =
          `\n\nFound ${output.totalMatches} total occurrence${output.totalMatches === 1 ? '' : 's'} ` +
          `across ${output.fileCount} file${output.fileCount === 1 ? '' : 's'}.`;
        return body + summary + (output.notice ? ` ${output.notice}` : '');
      }
      case 'content':
        return (output.output || 'No matches found') + (output.notice ? `\n\n${output.notice}` : '');
    }
  },
});


/**
 * 把输入翻译成 rg 参数。`--` 把模式与搜索目标同 rg 自身选项隔开,
 * 防止以 `-` 开头的模式被当成选项; --color=never 防配置强制上色污染记录。
 */
function buildRgArgs(input: GrepInput, searchTarget: string): string[] {
  const args: string[] = ['--hidden'];
  // 排除 VCS 元数据目录, 避免搜索历史/引用噪声。
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) args.push('--glob', `!${dir}`);

  // 防止 base64/minified 单行巨行吃掉输出行数与字节预算。
  args.push('--max-columns', '500');

  if (input.output_mode === 'files_with_matches') args.push('--files-with-matches');
  else if (input.output_mode === 'count') args.push('--count');

  if (input.multiline) args.push('-U', '--multiline-dotall');
  if (input.case_insensitive) args.push('--ignore-case');

  if (input.output_mode === 'content') {
    // -C 优先; 否则独立 -B/-A。
    if (input.context !== undefined) {
      args.push('-C', String(input.context));
    } else {
      if (input.context_before !== undefined) args.push('-B', String(input.context_before));
      if (input.context_after !== undefined) args.push('-A', String(input.context_after));
    }
    args.push('--line-number');
  }
  if (input.type) args.push('--type', input.type);
  if (input.glob) args.push('--glob', input.glob);

  args.push('--no-heading', '--color=never');
  args.push('--', input.pattern, searchTarget);
  return args;
}
