// 在明确的目录和结果预算内按文件名模式查找文件。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { globIterate } from 'glob';
import { buildTool } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextOk } from '../../contextValidation.js';
import { runBoundedProcess } from '../shared/BoundedProcess.js';

/** Glob 工具的窄 Context：工作区根 + per-call 取消信号。 */
interface GlobToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

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

const MAX_RESULTS = 100;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 10_000;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const GlobTool = buildTool<GlobInput, GlobResult, BuiltinToolContext, GlobToolContext>({
  id: BuiltinTools.Glob.id,
  name: BuiltinTools.Glob.name,
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

  validateContext(ctx) {
    return contextOk({
      workspaceRoot: ctx.workspaceRoot,
      signal: ctx.signal,
    });
  },

  async execute(input: GlobInput, context: GlobToolContext): Promise<GlobResult> {
    const workspaceRoot = context.workspaceRoot || process.cwd();
    const searchDir = input.path
      ? path.resolve(workspaceRoot, input.path)
      : workspaceRoot;

    // 优先 rg;Node glob 兜底。
    let found: { paths: string[]; truncated: boolean; reason?: string };
    try {
      found = await rgGlob(input.pattern, searchDir, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      found = await nodeGlob(input.pattern, searchDir, context.signal);
    }

    // 按 mtime 降序排
    const withMtime = found.paths.map((p) => {
      try {
        const { mtimeMs } = fs.statSync(p);
        return { p, mtime: mtimeMs };
      } catch {
        return { p, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const truncated = found.truncated;
    const files = withMtime.map((x) => x.p);
    const notice = truncated
      ? `[Search stopped at the ${found.reason ?? 'result'} limit; ${files.length} files shown. Narrow the pattern or path to continue.]`
      : undefined;

    return { files, truncated, notice };
  },
});

// ── 后端 ──────────────────────────────────────────────────────────────────────

async function rgGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<{ paths: string[]; truncated: boolean; reason?: string }> {
  const result = await runBoundedProcess(
    'rg',
    ['--files', '--glob', pattern, '--null', '.'],
    {
      cwd: searchDir,
      signal,
      delimiter: '\0',
      maxRecords: MAX_RESULTS,
      maxBytes: MAX_OUTPUT_BYTES,
      timeoutMs: SEARCH_TIMEOUT_MS,
    },
  );
  return {
    paths: result.records.map(item => path.resolve(searchDir, item)),
    truncated: result.truncated,
    ...(result.stopReason ? { reason: result.stopReason } : {}),
  };
}

async function nodeGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<{ paths: string[]; truncated: boolean; reason?: string }> {
  const paths: string[] = [];
  const startedAt = Date.now();
  let truncated = false;
  for await (const item of globIterate(pattern, {
    cwd: searchDir,
    absolute: true,
    nodir: true,
    signal,
  })) {
    if (paths.length >= MAX_RESULTS || Date.now() - startedAt >= SEARCH_TIMEOUT_MS) {
      truncated = true;
      break;
    }
    paths.push(String(item));
  }
  return { paths, truncated, ...(truncated ? { reason: 'result/time' } : {}) };
}
