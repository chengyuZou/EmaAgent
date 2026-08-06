// PowerShell 命令执行工具:无沙箱 Windows 的"AST 分析 + 逐条权限"路线。
// 安全链:validateInput(长度闸门 + AST 硬拦 deny 档) → getPermissionIntent(同一
// 分析映射风险档,经 LRU 缓存不重复起进程) → 引擎裁决 → powershellRunner 直接执行。
// 与 BashTool 的分工:Bash 走 OS 沙箱(bwrap/WSL),无沙箱时整体隐藏;
// 本工具专为无沙箱 Windows 存在,安全性不依赖 OS 隔离。

import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
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
} from './psParser.js';
import { powershellCommandIsSafe } from './security/powershellSecurity.js';
import { isReadOnlyCommand } from './security/readOnlyValidation.js';
import { interpretCommandResult } from './security/commandSemantics.js';
import { runPowerShellCommand } from './powershellRunner.js';
import { POWERSHELL_DESCRIPTION } from './prompt.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// ── 输入输出 ───────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  command: z.string().min(1).describe('The PowerShell command to execute.'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
}).strict();

type PowerShellInput = z.infer<typeof inputSchema>;

/** 与 BashCommandResult 同形(去掉 durationMs——耗时由执行层信封统一打),
 * 前端终端渲染与 Review 链路可零改造复用。 */
export interface PowerShellCommandResult {
  kind: 'commandResult';
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
  /** 退出码语义解释(robocopy 0-7 是成功 / findstr 1 是无匹配等)。 */
  note?: string;
}

/** 窄 Context:只要工作区(cwd);Shell 路径由探测模块提供,不进 Context。 */
interface PowerShellToolContext {
  workspaceRoot: string;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const PowerShellTool = buildTool<PowerShellInput, PowerShellCommandResult, PowerShellToolContext>({
  id: BuiltinTools.PowerShell.id,
  name: BuiltinTools.PowerShell.name,
  description: POWERSHELL_DESCRIPTION,

  inputSchema,
  // 静态只读证明需要 AST,而 isReadOnly 是同步钩子;保守报 false,
  // 只读优待(并发/低风险档)由 getPermissionIntent 里的真实分析给出。
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  getPermissionIntent: async (input) => {
    const parsed = await parsePowerShellCommand(input.command);
    const verdict = powershellCommandIsSafe(input.command, parsed);
    // ask 档(含 parse 失败的兜底):高风险、必须走规则/用户裁决。
    if (verdict.behavior !== 'passthrough') {
      return { riskLevel: 'high', accessType: 'execute', promptPolicy: 'whenRequired' };
    }
    if (isReadOnlyCommand(input.command, parsed)) {
      return { riskLevel: 'low', accessType: 'read', promptPolicy: 'whenRequired' };
    }
    return { riskLevel: 'medium', accessType: 'execute', promptPolicy: 'whenRequired' };
  },

  validateContext(ctx: ToolUseContext) {
    // 探测在模块加载时已预热;此处只读已结算的缓存。未结算按不可用处理
    // (fail-closed:该 Turn 不可见,下个 Turn 探测早已完成)。
    if (!peekPowerShellDetection()?.path) {
      return contextFail('当前环境未探测到 PowerShell(pwsh/powershell.exe)。');
    }
    if (!ctx.workspaceRoot) {
      return contextFail('PowerShell 需要先选择工作区。');
    }
    return contextOk({ workspaceRoot: ctx.workspaceRoot });
  },

  async validateInput(input) {
    // argv 预算是 UTF-8 字节数;超限命令无法交给 AST 分析,确定性拒绝。
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
    // deny 档(下载摇篮/混淆载荷):对 Agent 无合法用途,任何权限模式都不放行。
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

  async execute(input, context, invocation): Promise<PowerShellCommandResult> {
    const detection = await detectPowerShell();
    if (!detection.path) {
      throw new Error('PowerShell is not available on this machine.');
    }
    const result = await runPowerShellCommand(detection.path, input.command, {
      cwd: context.workspaceRoot,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      signal: invocation.signal,
    });
    // 退出码语义只作补充说明,不改写真实退出状态(robocopy 1 仍是 1)。
    const interpretation = interpretCommandResult(
      input.command,
      result.exitCode,
      result.stdout,
      result.stderr,
    );
    return {
      kind: 'commandResult',
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      aborted: result.aborted,
      ...(interpretation.message ? { note: interpretation.message } : {}),
    };
  },

  mapResultToModelContent(output) {
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
