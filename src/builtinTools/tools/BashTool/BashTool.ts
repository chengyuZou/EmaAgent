// 把 Bash 命令交给独立 Sandbox Runner 执行, 返回有界输出。
// 安全链: bashSecurity 静态分析(permissionMeta.safetyCheck 硬拦 + execute 复查)
// + Permission 规则裁决 + Sandbox 隔离, 三层互不替代。
import { z } from 'zod';
import {
  buildTool,
  createCommandPresentation,
  presentToolResult,
} from '@ema-agent/tools';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { analyzeBashCommand, splitCommandSegments } from './bashSecurity.js';
import { interpretExitCode } from './commandSemantics.js';

/** Bash 工具的窄 Context：只需命令执行器 + 执行身份。 */
interface BashToolContext {
  runner: CommandRunnerPort;
  signal: AbortSignal;
  workspaceRoot: string;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟
const MAX_TIMEOUT_MS = 600_000; // 10 分钟

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command to execute. Avoid interactive commands that require stdin.'),
  description: z
    .string()
    .optional()
    .describe('Brief description of what this command does (shown in permission dialogs).'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}. Max ${MAX_TIMEOUT_MS}.`),
});

type BashInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface BashResult {
  stdout:     string;
  stderr:     string;
  exitCode:   number;
  timedOut:   boolean;
  truncated:  boolean;
  durationMs: number;
  /** 进程被 per-tool abort 杀掉(非超时或 turn abort)时为 true。 */
  aborted: boolean;
  /** 退出码语义解释或破坏性命令提醒(grep 无匹配不是错误/git push -f 覆盖远端历史等)。 */
  note?: string;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const BashTool = buildTool<BashInput, BashResult, BuiltinToolContext, BashToolContext>({
  id: BuiltinTools.Bash.id,
  name: BuiltinTools.Bash.name,
  description: `Execute a bash/sh shell command inside the workspace sandbox and return stdout, stderr, and exit code.

Usage rules:
- Prefer the dedicated tools over shell equivalents: Read instead of cat, Edit instead of sed/awk, Write instead of echo >, Glob instead of find, Grep instead of grep — they carry finer-grained permissions and safer output budgets.
- Chain dependent commands with && (never newline-separated). Use ; only when failure of the previous step does not matter.
- Quote paths containing spaces. Verify a directory exists (ls) before creating files in it.
- Avoid interactive commands that read from stdin (they will hang).
- Git safety: never run destructive git commands (reset --hard, push --force, clean -f) unless the user explicitly asked; never use --no-verify; when a hook fails a commit, create a new commit instead of --amend.
- Output redirects (> and >>) may only target paths inside the workspace or the system temp directory (relative paths land in the workspace).
- Timeout defaults to 2 minutes (max 10). Background processes are not supported in V1.`,

  getToolUseSummary: (input) => input.description,

  inputSchema,
  isReadOnly: (input) => {
    // 结构化只读证明: 无重定向写入且每段都在只读白名单内。
    // 供 Manifest 与并发安全判定说真话; 权限放行仍由 Permission 决定。
    const verdict = analyzeBashCommand(input.command);
    return verdict.kind === 'ok' && verdict.readOnly;
  },
  isConcurrencySafe: () => false,

  requires: ['commandRunner'],

  validateContext(ctx) {
    if (!ctx.commandRunner) {
      return contextFail('当前执行环境没有 Shell 能力，请先选择工作区并检查 Sandbox 状态。');
    }
    return contextOk({
      runner: ctx.commandRunner,
      signal: ctx.signal,
      workspaceRoot: ctx.workspaceRoot,
    });
  },

  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
    bypassImmune: true, // 安全检查即使 bypass 模式也跑
    safetyCheck: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return 'continue';
      // 静态分析只表达硬拦截(deny); ask 档由 Bash 高风险默认确认流程兜住。
      return analyzeBashCommand(parsed.data.command).kind === 'deny' ? 'deny' : 'continue';
    },
  },

  async execute(
    input: BashInput,
    context: BashToolContext,
  ): Promise<BashResult> {
    const { command, timeout } = input;

    // 执行前复查: 直接分发(未过 Permission)时硬拦依然生效。
    const verdict = analyzeBashCommand(command);
    if (verdict.kind === 'deny') {
      throw new Error(`Command blocked by safety policy: ${verdict.reason ?? command}`);
    }

    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const startMs = Date.now();

    const result = await context.runner.run(command, {
      cwd: context.workspaceRoot,
      timeoutMs,
      signal: context.signal,
    });

    // 退出码语义(grep 无匹配/diff 有差异不是错误) + 破坏性命令提醒, 拼进 note。
    const notes: string[] = [];
    const lastSegment = splitCommandSegments(command).at(-1) ?? command;
    const lastBase = /^(\S+)/.exec(lastSegment)?.[1]?.replace(/^.*\//, '') ?? '';
    const interpretation = interpretExitCode(lastBase, result.exitCode);
    if (interpretation.note) notes.push(interpretation.note);
    for (const warning of verdict.warnings) notes.push(warning);

    return presentToolResult(
      {
        ...result,
        durationMs: Date.now() - startMs,
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      },
      createCommandPresentation({
        command,
        workingDirectory: context.workspaceRoot,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        truncated: result.truncated,
      }),
    );
  },
});
