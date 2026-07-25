// 在明确的目录和结果预算内按文件名模式查找文件。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { globIterate } from 'glob';
import {
  buildTool,
  createSearchPresentation,
  presentToolResult,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';
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

  requires: ['workspaceRoot'],

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('Glob 工具需要明确的工作区，禁止回退到 Sidecar 进程目录。');
    }
    return contextOk({
      workspaceRoot: ctx.workspaceRoot,
      signal: ctx.signal,
    });
  },

  async execute(input: GlobInput, context: GlobToolContext): Promise<GlobResult> {
    const workspaceRoot = context.workspaceRoot;
    const searchDir = input.path
      ? path.resolve(workspaceRoot, input.path)
      : workspaceRoot;

    // 优先 rg;Node glob 兜底。
    let found: { paths: string[]; enumTruncated: boolean };
    try {
      found = await rgGlob(input.pattern, searchDir, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      found = await nodeGlob(input.pattern, searchDir, context.signal);
    }

    // 枚举后才排序截取: "最近修改的 100 个"必须先枚举再按 mtime 降序,
    // 不能取遍历序前 100 再排序(大目录下不是真正的新文件)。
    const { files, truncated } = newestFirst(found.paths);
    const notice = truncated
      ? `[Showing the ${MAX_RESULTS} most recently modified of ${found.paths.length}${found.enumTruncated ? '+' : ''} matches. Narrow the pattern or path to continue.]`
      : undefined;

    return presentToolResult(
      { files, truncated, notice },
      createSearchPresentation({
        operation: 'file_search',
        pattern: input.pattern,
        searchPath: searchDir,
        resultCount: files.length,
        truncated,
        ...(truncated ? { limitReason: 'results' as const } : {}),
      }),
    );
  },
});

// ── 后端 ──────────────────────────────────────────────────────────────────────

/**
 * 枚举上限: "最近修改的 100 个"必须先枚举再按 mtime 排序,
 * 不能只取遍历序前 100(大目录下会漏掉真正的新文件)。
 * 超过上限照样报截断, 提示用户缩小范围。
 */
const MAX_ENUMERATION = 20_000;

/** 按 mtime 降序(相同 mtime 按路径字典序决胜); stat 失败的按 mtime 0 排尾。 */
export function sortByMtimeDesc(paths: string[]): string[] {
  const withMtime = paths.map((p) => {
    try {
      const { mtimeMs } = fs.statSync(p);
      return { p, mtime: mtimeMs };
    } catch {
      return { p, mtime: 0 };
    }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime || a.p.localeCompare(b.p));
  return withMtime.map((x) => x.p);
}

/** 枚举 → mtime 降序 → 取前 MAX_RESULTS。两条后端共用同一收口。 */
function newestFirst(paths: string[]): { files: string[]; truncated: boolean } {
  const sorted = sortByMtimeDesc(paths);
  return {
    files: sorted.slice(0, MAX_RESULTS),
    truncated: sorted.length > MAX_RESULTS,
  };
}

async function rgGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<{ paths: string[]; enumTruncated: boolean }> {
  const result = await runBoundedProcess(
    'rg',
    ['--files', '--glob', pattern, '--null', '.'],
    {
      cwd: searchDir,
      signal,
      delimiter: '\0',
      maxRecords: MAX_ENUMERATION,
      maxBytes: MAX_OUTPUT_BYTES,
      timeoutMs: SEARCH_TIMEOUT_MS,
    },
  );
  return {
    paths: result.records.map(item => path.resolve(searchDir, item)),
    enumTruncated: result.truncated,
  };
}

async function nodeGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<{ paths: string[]; enumTruncated: boolean }> {
  const paths: string[] = [];
  const startedAt = Date.now();
  let enumTruncated = false;
  for await (const item of globIterate(pattern, {
    cwd: searchDir,
    absolute: true,
    nodir: true,
    signal,
  })) {
    if (paths.length >= MAX_ENUMERATION || Date.now() - startedAt >= SEARCH_TIMEOUT_MS) {
      enumTruncated = true;
      break;
    }
    paths.push(String(item));
  }
  return { paths, enumTruncated };
}
