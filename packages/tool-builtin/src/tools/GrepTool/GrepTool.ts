// 这个工具负责通过 ripgrep 在时间、输出和结果数量预算内搜索文件内容。
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { runBoundedProcess } from '../shared/BoundedProcess.js';

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
    .describe('Lines of context before and after each match (only for content mode).'),
  case_insensitive: z.boolean().default(false).describe('Case-insensitive matching.'),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(250)
    .describe('Maximum output lines / entries returned.'),
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

export const GrepTool = buildTool<GrepInput, GrepResult>({
  id: BuiltinTools.Grep.id,
  name: BuiltinTools.Grep.name,
  description: `Regex content search powered by ripgrep.

Output modes:
- \`files_with_matches\` (default) - list file paths that contain the pattern
- \`content\` - show matching lines, with optional surrounding context lines
- \`count\` - show match count per file

Use \`glob\` to restrict which files are searched (e.g. \`"*.ts"\`).
Results are capped at \`head_limit\` lines (default 250).`,

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

  async execute(input: GrepInput, ctx: ToolExecutionContext): Promise<GrepResult> {
    const {
      pattern,
      path: inputPath,
      glob: globFilter,
      output_mode,
      context: contextLines,
      case_insensitive,
      head_limit,
    } = input;

    const workspaceRoot = ctx.workspaceRoot || process.cwd();
    const searchTargets = inputPath
      ? [path.resolve(workspaceRoot, inputPath)]
      : [workspaceRoot];

    const args: string[] = [];

    // 模式标志
    if (output_mode === 'files_with_matches') args.push('--files-with-matches');
    else if (output_mode === 'count') args.push('--count');
    // content 模式:rg 默认行为(显示匹配行)

    if (contextLines !== undefined && output_mode === 'content') {
      args.push('-C', String(contextLines));
    }
    if (case_insensitive) args.push('--ignore-case');
    if (globFilter) args.push('--glob', globFilter);

    // content 模式下行号有用
    if (output_mode === 'content') args.push('--line-number');

    args.push('--no-heading', '--color=never');
    // `--` 把模型提供的 pattern/path 与 rg 自身参数隔开，避免以 `-` 开头的内容被当成选项。
    args.push('--', pattern, ...searchTargets);

    let result;
    try {
      result = await runBoundedProcess('rg', args, {
        signal: ctx.signal,
        delimiter: '\n',
        maxRecords: head_limit,
        maxBytes: MAX_OUTPUT_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
        allowedExitCodes: [0, 1],
      });
    } catch (err: unknown) {
      throw err;
    }

    const trimmed = result.records.join('\n');
    const output = result.truncated
      ? `${trimmed}${trimmed ? '\n' : ''}[Search stopped at the ${result.stopReason ?? 'output'} limit. Use a narrower pattern, path, or glob filter.]`
      : trimmed;

    return {
      output,
      truncated: result.truncated,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    };
  },
});
