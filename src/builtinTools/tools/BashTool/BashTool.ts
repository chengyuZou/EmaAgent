import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { findMatchingContentRule, matchShellRule } from '@ema-agent/permission';
import {
  buildTool,
  contextFail,
  contextOk,
  type BackgroundProcessPort,
  type ToolInvocation,
} from '@ema-agent/tools';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { analyzeBashCommand, splitCommandSegments } from './security/bashSecurity.js';
import { interpretExitCode } from './commandSemantics.js';
import { BASH_DESCRIPTION } from './prompt.js';

/** Bash 工具的窄 Context：命令执行器与后台进程入口;身份与取消走 ToolInvocation。 */
interface BashToolContext {
  runner: CommandRunnerPort;
  backgroundProcesses: BackgroundProcessPort;
  workspaceRoot: string;
}

/** 交互等待期的输出增量(转交后台后不再上报)。 */
export interface BashProgress {
  stream: 'stdout' | 'stderr';
  text: string;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * 命令字符串上限: 压 Windows CreateProcess 的 32,767 字符硬上限以下
 * (WSL 路径转义最坏 4 倍膨胀),超限给模型可读错误而不是平台 EINVAL。
 * 与防卡死无关——字符串不存在卡死路径,超限 spawn 本就诚实失败。
 */
const MAX_COMMAND_CHARS = 30_000;

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(MAX_COMMAND_CHARS)
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
  /** 日志落盘位置(相对数据目录), 模型可 Read 完整输出。 */
  outputRelativePath: string;
}

export type BashResult = BashCommandResult | BashProcessReference;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const BashTool = buildTool<BashInput, BashResult, BashToolContext, BashProgress>({
  id: BuiltinTools.Bash.id,
  name: BuiltinTools.Bash.name,
  description: BASH_DESCRIPTION,

  getToolUseSummary: (input) => input.description,

  inputSchema,
  isReadOnly: (input) => {
    // 结构化只读证明: 无重定向写入且每段都在只读白名单内。
    // 供并发安全判定说真话; 权限放行仍由 Permission 决定。
    const verdict = analyzeBashCommand(input.command);
    return verdict.kind === 'ok' && verdict.readOnly;
  },
  isConcurrencySafe: () => false,

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('Shell 工具需要明确的工作区。');
    }
    if (!ctx.commandRunner || !ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有 Shell 能力，请先选择工作区并检查 Sandbox 状态。');
    }
    return contextOk({
      runner: ctx.commandRunner,
      backgroundProcesses: ctx.backgroundProcesses,
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

  // 内容规则按 shell 模式匹配（exact / :* / wildcard）；deny → ask → allow。
  // 命令安全由 bashSecurity（validateInput 硬拦 + execute 复查）兜底，二者互补。
  async checkPermissions(input, _context, permissionContext) {
    const command = input.command;
    const denyRule = findMatchingContentRule(
      permissionContext, BuiltinTools.Bash.name, 'deny',
      (content) => matchShellRule(content, command),
    );
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `已禁止执行: ${command}`,
        decisionReason: { type: 'rule', rule: denyRule },
      };
    }
    const askRule = findMatchingContentRule(
      permissionContext, BuiltinTools.Bash.name, 'ask',
      (content) => matchShellRule(content, command),
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `执行 ${command} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
      };
    }
    const allowRule = findMatchingContentRule(
      permissionContext, BuiltinTools.Bash.name, 'allow',
      (content) => matchShellRule(content, command),
    );
    if (allowRule) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'rule', rule: allowRule },
      };
    }
    return { behavior: 'passthrough', message: '执行命令需要用户确认' };
  },

  async execute(
    input: BashInput,
    context: BashToolContext,
    invocation: ToolInvocation,
    onProgress?: (progress: BashProgress) => void,
  ): Promise<BashResult> {
    const { command, timeout, runInBackground } = input;

    // 执行前复查: 直接分发(未过 Permission)时硬拦依然生效。
    const verdict = analyzeBashCommand(command);
    if (verdict.kind === 'deny') {
      throw new Error(`Command blocked by safety policy: ${verdict.reason ?? command}`);
    }

    // 进度上报: 跨 chunk 的多字节字符用 StringDecoder 拼齐, 不发半个字符。
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const emitChunk = (stream: 'stdout' | 'stderr', data: Uint8Array): void => {
      if (!onProgress) return;
      const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(Buffer.from(data));
      if (text) onProgress({ stream, text });
    };

    const lastSegment = splitCommandSegments(command).at(-1) ?? command;
    const lastBase = /^(\S+)/.exec(lastSegment)?.[1]?.replace(/^.*\//, '') ?? '';
    const result = await context.backgroundProcesses.runCommand({
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      toolCallId: invocation.toolCallId,
      runner: context.runner,
      command,
      description: input.description,
      cwd: context.workspaceRoot,
      timeoutMs: timeout,
      runInBackground,
      waitSignal: invocation.signal,
      isSuccessfulExitCode: exitCode =>
        interpretExitCode(lastBase, exitCode).ok,
      onOutput: onProgress
        ? chunk => emitChunk(chunk.stream, chunk.data)
        : undefined,
    });

    if (result.kind === 'processReference') {
      return {
        kind: result.kind,
        backgroundProcessId: result.backgroundProcessId,
        status: result.status,
        outputPreview: result.outputPreview,
        outputRelativePath: result.outputRelativePath,
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

  mapResultToModelContent(output) {
    if (output.kind === 'processReference') {
      return `Command is running in the background (id: ${output.backgroundProcessId}, status: ${output.status}).\n`
        + `Output so far: ${output.outputPreview}\n`
        + `You will be notified when it completes. To inspect progress, use ProcessOutput `
        + `or Read the log at: ${output.outputRelativePath}`;
    }
    const parts: string[] = [];
    if (output.stdout.trim()) parts.push(output.stdout.trimEnd());
    if (output.stderr.trim()) parts.push(`[stderr]\n${output.stderr.trimEnd()}`);
    if (output.timedOut) parts.push('[timed out]');
    if (output.truncated) parts.push('[output truncated]');
    if (output.note) parts.push(output.note);
    return parts.length > 0 ? parts.join('\n') : '(command completed with no output)';
  },
});
