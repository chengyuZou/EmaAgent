// 使用本机 PowerShell, 不套用 Bash 的操作系统沙箱.
// AST 禁止检查与权限确认发生在执行前; 共享执行层管理输出, 超时和停止.

import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type BackgroundProcess,
  type ToolUseContext,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import {
  detectPowerShell,
  peekPowerShellDetection,
} from './powershellDetection.js';
import {
  MAX_COMMAND_LENGTH,
  parsePowerShellCommand,
  getAllCommands,
  deriveSecurityFlags,
} from './psParser.js';
import { checkShellContentPermission } from '../shared/shellPermission.js';
import { powershellCommandIsSafe } from './security/powershellSecurity.js';
import { interpretCommandResult } from './security/commandSemantics.js';
import { startPowerShellCommand } from './powershellRunner.js';
import { POWERSHELL_DESCRIPTION } from './prompt.js';
import {
  createShellOutputCallback,
  shellBackgroundSchema,
  shellProcessReferenceText,
  shellTimeoutSchema,
  type ShellProgress,
  type ShellResult,
} from '../shared/shellExecution.js';



const inputSchema = z.object({
  command: z.string().min(1).describe('The PowerShell command to execute.'),
  description: z.string().optional().describe('Brief description of what this command does (shown in permission dialogs).'),
  timeout: shellTimeoutSchema,
  runInBackground: shellBackgroundSchema,
}).strict();

type PowerShellInput = z.infer<typeof inputSchema>;

interface PowerShellToolContext {
  cwd: string;
  backgroundProcesses: BackgroundProcess;
}



export const PowerShellTool = buildTool<PowerShellInput, ShellResult, PowerShellToolContext, ShellProgress>({
  id: BuiltinTools.PowerShell.id,
  name: BuiltinTools.PowerShell.name,
  description: POWERSHELL_DESCRIPTION,

  inputSchema,
  getToolUseSummary: input => input.description,
  // 静态只读证明需要 AST,而 isReadOnly 是同步钩子;保守报 false.
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  // 解析函数已有命令级缓存, 与 validateInput 共用结果; 权限规则逐段检查.
  async checkPermissions(input, _context, permissionContext) {
    const parsed = await parsePowerShellCommand(input.command);
    const commands = getAllCommands(parsed);
    const flags = deriveSecurityFlags(parsed);
    const allowByCommands = parsed.valid && !parsed.hasStopParsing
      && !flags.hasAssignments && !flags.hasSubExpressions && !flags.hasScriptBlocks
      && !flags.hasExpandableStrings && !flags.hasMemberInvocations && !flags.hasSplatting
      && parsed.statements.every(statement =>
        (statement.statementType === 'PipelineAst' || statement.statementType === 'PipelineChainAst')
        && (statement.commands.length > 0 || (statement.nestedCommands?.length ?? 0) > 0))
      && commands.every(command => command.elementType === 'CommandAst');
    return checkShellContentPermission(
      BuiltinTools.PowerShell.name, input.command, commands.map(command => command.text),
      allowByCommands, permissionContext,
    );
  },

  validateContext(ctx: ToolUseContext) {
    // 探测在模块加载时已预热;此处只读已结算的缓存.未结算按不可用处理
    // 未结算时本次调用返回不可用, 后续调用会读取结算后的探测结果.
    if (!peekPowerShellDetection()?.path) {
      return contextFail('当前环境未探测到 PowerShell(pwsh/powershell.exe).');
    }
    if (!ctx.cwd) {
      return contextFail('PowerShell 需要先选择工作区.');
    }
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力.');
    }
    return contextOk({ cwd: ctx.cwd, backgroundProcesses: ctx.backgroundProcesses });
  },

  async validateInput(input) {
    // argv 预算是 UTF-8 字节数;超限命令无法交给 AST 分析,确定性拒绝.
    const commandBytes = Buffer.byteLength(input.command, 'utf8');
    if (commandBytes > MAX_COMMAND_LENGTH) {
      return {
        valid: false,
        code: 'powershell/command_too_long',
        message: `Command is ${commandBytes} bytes, exceeding the ${MAX_COMMAND_LENGTH}-byte analysis budget. Split it into smaller commands.`,
        retryable: false,
      };
    }
    const parsed = await parsePowerShellCommand(input.command);
    const verdict = powershellCommandIsSafe(input.command, parsed);
    // deny 是工具的禁止模式, 在权限规则前拒绝, 不由 allow 规则跳过.
    if (verdict.behavior === 'deny') {
      return {
        valid: false,
        code: 'powershell/unsafe_command',
        message: `Command blocked by safety policy: ${verdict.message ?? input.command}`,
        retryable: false,
      };
    }
    return { valid: true };
  },

  async execute(input, context, invocation, onProgress): Promise<ShellResult> {
    const detection = await detectPowerShell();
    if (!detection.path) {
      throw new Error('PowerShell is not available on this machine.');
    }
    const shellPath = detection.path;
    const result = await context.backgroundProcesses.runCommand({
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      toolCallId: invocation.toolCallId,
      runner: {
        start: (command, options) => startPowerShellCommand(shellPath, command, {
          ...options,
          cwd: context.cwd,
        }),
      },
      command: input.command,
      description: input.description,
      cwd: context.cwd,
      timeoutMs: input.timeout,
      runInBackground: input.runInBackground,
      waitSignal: invocation.signal,
      isSuccessfulExitCode: exitCode =>
        !interpretCommandResult(input.command, exitCode, '', '').isError,
      onOutput: createShellOutputCallback(onProgress),
    });
    if (result.kind === 'processReference') return result;
    // 退出码语义只作补充说明,不改写真实退出状态(robocopy 1 仍是 1).
    const interpretation = interpretCommandResult(
      input.command,
      result.result.exitCode,
      result.result.stdout,
      result.result.stderr,
    );
    return {
      kind: 'commandResult',
      ...result.result,
      durationMs: result.durationMs,
      ...(interpretation.message ? { note: interpretation.message } : {}),
    };
  },

  mapResultToModelContent(output) {
    if (output.kind === 'processReference') return shellProcessReferenceText(output);
    const parts: string[] = [];
    if (output.stdout.trim()) parts.push(output.stdout.trimEnd());
    if (output.stderr.trim()) parts.push(`[stderr]\n${output.stderr.trimEnd()}`);
    if (output.exitCode !== 0) parts.push(`[exit code ${output.exitCode}]`);
    if (output.timedOut) parts.push('[timed out]');
    if (output.aborted) parts.push('[aborted]');
    if (output.truncated) parts.push('[output truncated]');
    if (output.note) parts.push(output.note);
    return parts.length > 0 ? parts.join('\n') : '(command completed with no output)';
  },
});
