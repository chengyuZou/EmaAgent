// 把 Bash 命令交给独立 Sandbox Runner 执行, 返回有界输出。
// 安全链: bashSecurity 静态分析(validateInput 硬拦 + execute 复查)
// + Permission 规则裁决 + Sandbox 隔离, 三层互不替代。
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type BackgroundProcessPort,
  type BuiltinToolContext,
} from '@ema-agent/tools';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { analyzeBashCommand, splitCommandSegments } from './bashSecurity.js';
import { interpretExitCode } from './commandSemantics.js';

/** Bash 工具的窄 Context：只需命令执行器 + 执行身份。 */
interface BashToolContext {
  runner: CommandRunnerPort;
  backgroundProcesses: BackgroundProcessPort;
  sessionId: SessionId;
  turnId: TurnId;
  toolCallId: ToolCallId;
  signal: AbortSignal;
  workspaceRoot: string;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

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
    .describe('Maximum total runtime in milliseconds. Defaults to the user setting.'),
  runInBackground: z
    .boolean()
    .optional()
    .describe('Start in the background immediately instead of waiting up to 15 seconds.'),
});

type BashInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface BashCommandResult {
  kind: 'commandResult';
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

export interface BashProcessReference {
  kind: 'processReference';
  backgroundProcessId: string;
  status: 'queued' | 'running';
  outputPreview: string;
}

export type BashResult = BashCommandResult | BashProcessReference;

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
- Commands that finish within 15 seconds return their result directly. Slower commands keep running as background processes without being restarted.
- Set runInBackground=true when the command is expected to be long-running. Use ProcessOutput to read incremental output and ProcessStop to terminate it.
- timeout is the total runtime limit. When omitted, the user's background-process setting applies.`,

  getToolUseSummary: (input) => input.description,

  inputSchema,
  isReadOnly: (input) => {
    // 结构化只读证明: 无重定向写入且每段都在只读白名单内。
    // 供 Manifest 与并发安全判定说真话; 权限放行仍由 Permission 决定。
    const verdict = analyzeBashCommand(input.command);
    return verdict.kind === 'ok' && verdict.readOnly;
  },
  isConcurrencySafe: () => false,

  requires: ['commandRunner', 'backgroundProcesses'],

  validateContext(ctx) {
    if (!ctx.commandRunner || !ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有 Shell 能力，请先选择工作区并检查 Sandbox 状态。');
    }
    if (!ctx.toolCallId) {
      return contextFail('Shell 调用缺少 toolCallId，不能建立可审计的进程身份。');
    }
    return contextOk({
      runner: ctx.commandRunner,
      backgroundProcesses: ctx.backgroundProcesses,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId: ctx.toolCallId,
      signal: ctx.signal,
      workspaceRoot: ctx.workspaceRoot,
    });
  },

  validateInput(input) {
    const verdict = analyzeBashCommand(input.command);
    return verdict.kind === 'deny'
      ? {
          valid: false,
          code: 'bash/unsafe_command',
          message: `Command blocked by safety policy: ${verdict.reason ?? input.command}`,
          retryable: false,
        }
      : { valid: true };
  },

  getPermissionIntent: () => ({
    riskLevel: 'high',
    accessType: 'execute',
    promptPolicy: 'whenRequired',
  }),

  async execute(
    input: BashInput,
    context: BashToolContext,
  ): Promise<BashResult> {
    const { command, timeout, runInBackground } = input;

    // 执行前复查: 直接分发(未过 Permission)时硬拦依然生效。
    const verdict = analyzeBashCommand(command);
    if (verdict.kind === 'deny') {
      throw new Error(`Command blocked by safety policy: ${verdict.reason ?? command}`);
    }

    const lastSegment = splitCommandSegments(command).at(-1) ?? command;
    const lastBase = /^(\S+)/.exec(lastSegment)?.[1]?.replace(/^.*\//, '') ?? '';
    const result = await context.backgroundProcesses.runCommand({
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      runner: context.runner,
      command,
      description: input.description,
      cwd: context.workspaceRoot,
      timeoutMs: timeout,
      runInBackground,
      waitSignal: context.signal,
      isSuccessfulExitCode: exitCode =>
        interpretExitCode(lastBase, exitCode).ok,
    });

    if (result.kind === 'processReference') {
      return {
        kind: result.kind,
        backgroundProcessId: result.backgroundProcessId,
        status: result.status,
        outputPreview: result.outputPreview,
      };
    }

    const interpretation = interpretExitCode(lastBase, result.result.exitCode);
    if (!interpretation.ok) {
      const detail = result.result.stderr.trim() || result.result.stdout.trim();
      throw new Error(
        `Command exited with code ${result.result.exitCode}`
        + (detail ? `: ${detail.slice(0, 2_000)}` : ''),
      );
    }

    // 退出码语义与静态安全提醒只作为补充说明，不改变真实退出状态。
    const notes: string[] = [];
    if (interpretation.note) notes.push(interpretation.note);
    for (const warning of verdict.warnings) notes.push(warning);

    return {
      kind: 'commandResult',
      ...result.result,
      durationMs: result.durationMs,
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    };
  },
});
