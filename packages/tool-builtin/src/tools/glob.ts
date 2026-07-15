import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';

const execFileAsync = promisify(execFile);

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  pattern: z.string().min(1).describe(
    'Glob pattern, e.g. "**/*.ts" or "src/**/*.{tsx,jsx}". ' +
      'Relative patterns are resolved against `path`.',
  ),
  path: z
    .string()
    .optional()
    .describe('Directory to search in. Defaults to the workspace root.'),
});

type GlobInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface GlobResult {
  /** 匹配的文件路径,按 mtime 降序(最近修改的在前)。 */
  files: string[];
  truncated: boolean;
  /** 仅 truncated=true 时存在。给模型的人类可读提示。 */
  notice?: string;
}

const MAX_RESULTS = 1000;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const globTool = buildTool<GlobInput, GlobResult>({
  name: 'glob',
  description: `Fast file pattern matching using ripgrep's --files mode.

- Supports glob syntax: \`**/*.ts\`, \`src/**/*.{tsx,jsx}\`, etc.
- Results are sorted by modification time (newest first) - up to ${MAX_RESULTS} files.
- Use \`path\` to restrict the search to a subdirectory.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel:   'low',
    accessType:  'read',
    // 提供 `path` 时,搜索根传给 PermissionEngine 以强制工作区边界检查。
    // 缺失时工具默认 ctx.workspaceRoot(总在界内),故传 undefined,
    // 让标准的 workspace-read 快速路径适用。
    extractPath: (input) => (input as { path?: string }).path,
  },

  async execute(input: GlobInput, ctx: ToolExecutionContext): Promise<GlobResult> {
    const searchDir = input.path
      ? path.resolve(input.path)
      : (ctx.workspaceRoot || process.cwd());

    // 优先 rg;Node glob 兜底。
    const allPaths: string[] = [];
    try {
      allPaths.push(...await rgGlob(input.pattern, searchDir, ctx.signal));
    } catch {
      allPaths.push(...await nodeGlob(input.pattern, searchDir, ctx.signal));
    }
    const rawPaths = allPaths;

    // 按 mtime 降序排
    const withMtime = rawPaths.map((p) => {
      try {
        const { mtimeMs } = fs.statSync(p);
        return { p, mtime: mtimeMs };
      } catch {
        return { p, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const truncated = withMtime.length > MAX_RESULTS;
    const files = withMtime.slice(0, MAX_RESULTS).map((x) => x.p);
    const notice = truncated
      ? `[Output truncated: ${withMtime.length.toLocaleString()} matches -> ${MAX_RESULTS} shown. Narrow your pattern or path to see more.]`
      : undefined;

    return { files, truncated, notice };
  },
});

// ── 后端 ──────────────────────────────────────────────────────────────────────

async function rgGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'rg',
    ['--files', '--glob', pattern, '--null', '.'],
    { cwd: searchDir, signal, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean).map((p) => path.resolve(searchDir, p));
}

async function nodeGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  // 动态 import - glob 是常用依赖,我们在 package.json 加了
  const { glob } = await import('glob');
  const results = await glob(pattern, {
    cwd: searchDir,
    absolute: true,
    nodir: true,
    signal,
  });
  return results;
}
