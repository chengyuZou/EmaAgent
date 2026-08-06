// 在明确的目录和结果预算内按文件名模式查找文件。
// 模型说明书见 prompt.ts; rg --files 枚举, node glob 兜底; 结果相对工作区返回。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { globIterate } from 'glob';
import { buildTool, contextFail, contextOk, type ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { runBoundedProcess } from '../shared/BoundedProcess.js';
import { sortPathsByMtimeDesc } from '../shared/fileMtimeSort.js';
import { GLOB_DESCRIPTION } from './prompt.js';

/** Glob 工具的窄 Context：只取工作区根；取消信号走 ToolInvocation。 */
interface GlobToolContext {
  workspaceRoot: string;
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
    .describe(
      'Directory to search in. Defaults to the workspace root. ' +
        'Omit this field to use the default directory — do not enter "undefined" or "null".',
    ),
});

type GlobInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface GlobResult {
  /** 匹配的文件路径(相对工作区, '/' 分隔),按 mtime 降序(最近修改的在前)。 */
  files: string[];
  /** 枚举或结果超限时为 true。 */
  truncated: boolean;
  /** 仅 truncated=true 时存在。给模型的人类可读提示。 */
  notice?: string;
}

// ── 结果预算 ──────────────────────────────────────────────────────────────────

/** 模型可见条数上限: "最近修改的前 N 个"。 */
const MAX_RESULTS = 100;
/** 枚举上限: 先枚举再按 mtime 排序, 不能只取遍历序前 100(大目录下会漏掉真正的新文件)。 */
const MAX_ENUMERATION = 20_000;
/** 单次搜索超时: 防失控目录拖死 Turn。 */
const SEARCH_TIMEOUT_MS = 10_000;
/** rg 输出解析字节预算: 有界读取, 超限即截断。 */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const GlobTool = buildTool<GlobInput, GlobResult, GlobToolContext>({
  id: BuiltinTools.Glob.id,
  name: BuiltinTools.Glob.name,
  description: GLOB_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('Glob 工具需要明确的工作区，禁止回退到 Sidecar 进程目录。');
    }
    return contextOk({ workspaceRoot: ctx.workspaceRoot });
  },

  validateInput(input, context) {
    if (!input.path) return { valid: true };
    // UNC 跳过 stat: stat 本身会触发 SMB 认证, NTLM 凭据泄露; Permission 层会拦。
    if (input.path.startsWith('\\\\') || input.path.startsWith('//')) return { valid: true };
    const resolved = path.resolve(context.workspaceRoot, input.path);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { valid: false, message: `Path is not a directory: ${input.path}` };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { valid: false, message: `Directory does not exist: ${input.path}` };
      }
      return { valid: false, message: `Cannot access directory: ${input.path}` };
    }
    return { valid: true };
  },

  getPermissionIntent: (input, context) => ({
    riskLevel: 'low',
    accessType: 'read',
    targets: [{
      path: input.path ? path.resolve(context.workspaceRoot, input.path) : context.workspaceRoot,
      accessType: 'read',
    }],
    promptPolicy: 'whenRequired',
  }),

  async execute(
    input: GlobInput,
    context: GlobToolContext,
    invocation: ToolInvocation,
  ): Promise<GlobResult> {
    const workspaceRoot = context.workspaceRoot;
    const searchDir = input.path
      ? path.resolve(workspaceRoot, input.path)
      : workspaceRoot;

    // 优先 rg; Node glob 兜底(机器无 rg 或 rg 出错时)。
    let found: { paths: string[]; enumTruncated: boolean };
    try {
      found = await rgGlob(input.pattern, searchDir, invocation.signal);
    } catch (error) {
      if (invocation.signal.aborted) throw error;
      found = await nodeGlob(input.pattern, searchDir, invocation.signal);
    }

    // 枚举后才排序截取
    // 不能取遍历序再排序(大目录下不是真正的新文件)。
    const sorted = await sortPathsByMtimeDesc(found.paths);
    const files = sorted.slice(0, MAX_RESULTS);
    const truncated = sorted.length > MAX_RESULTS || found.enumTruncated;
    const notice = truncated
      ? `[Showing the ${MAX_RESULTS} most recently modified of ${found.paths.length}${found.enumTruncated ? '+' : ''} matches. Narrow the pattern or path to continue.]`
      : undefined;

    // 相对化到工作区省 token; 与 Read/Edit 的 file_path 回填口径一致(两者都按工作区解析)。
    return {
      files: files.map((p) => toWorkspaceRelative(workspaceRoot, p)),
      truncated,
      notice,
    };
  },

  mapResultToModelContent(output) {
    if (output.files.length === 0) return 'No files found';
    return [
      ...output.files,
      ...(output.truncated
        ? ['(Results are truncated. Consider using a more specific path or pattern.)']
        : []),
    ].join('\n');
  },
});

// ── 后端 ──────────────────────────────────────────────────────────────────────

/** 把工作区内的绝对路径转成相对路径('/' 分隔), 供模型直接回填 Read/Edit。 */
function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(workspaceRoot, absolutePath);
  return rel ? rel.replace(/\\/g, '/') : path.basename(absolutePath);
}

/** rg --files 枚举: 文件名模式, 不读内容; --color=never 防配置强制上色污染记录。 */
async function rgGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<{ paths: string[]; enumTruncated: boolean }> {
  const result = await runBoundedProcess(
    'rg',
    ['--files', '--glob', pattern, '--null', '--color=never', '.'],
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

/** Node glob 兜底: 无 rg 时的枚举, 同样受条数与超时有界。 */
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
