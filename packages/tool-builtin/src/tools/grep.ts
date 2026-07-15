import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';

const execFileAsync = promisify(execFile);

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
    .default(250)
    .describe('Maximum output lines / entries returned.'),
});

type GrepInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface GrepResult {
  output: string;
  truncated: boolean;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const grepTool = buildTool<GrepInput, GrepResult>({
  name: 'grep',
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

    const searchTargets = inputPath
      ? [path.resolve(inputPath)]
      : [ctx.workspaceRoot || process.cwd()];

    const args: string[] = [pattern];

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
    args.push(...searchTargets);

    let stdout: string;
    try {
      const result = await execFileAsync('rg', args, {
        signal: ctx.signal,
        maxBuffer: 50 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err: unknown) {
      // rg 无匹配时退出码 1 - 不是错误
      const execErr = err as { code?: number; stdout?: string };
      if (execErr.code === 1) return { output: '', truncated: false };
      throw err;
    }

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const truncated = lines.length > head_limit;
    const trimmed   = lines.slice(0, head_limit).join('\n');
    const output    = truncated
      ? trimmed + `\n[Output truncated: ${lines.length.toLocaleString()} lines -> ${head_limit} shown. Use a narrower pattern or glob filter to see more.]`
      : trimmed;

    return { output, truncated };
  },
});
