// 这个工具负责把 Bash 命令交给独立 Sandbox Runner 执行，并返回有界输出。
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { buildTool, spawnProcess } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟
const MAX_TIMEOUT_MS = 600_000; // 10 分钟

/**
 * 绝不能执行的命令 - 即使 bypass 模式也不行。
 * 这些会造成不可逆系统损害。
 */
const BANNED_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive.*--force|--force.*--recursive)\b/i,
  /\bformat\s+(c:|\/dev\/)/i,
  /\bmkfs\b/i,
  /:\(\)\{\s*:\|:\s*&\s*\};:/,  // fork 炸弹
  /\bdd\s+.*of=\/dev\/(s|h)d/i,
  /\bsudo\s+rm\b/i,
];

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
  run_in_background: z
    .boolean()
    .default(false)
    .describe('Fire-and-forget. Returns immediately; stdout/stderr are not captured.'),
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
  aborted?:   boolean;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const BashTool = buildTool<BashInput, BashResult>({
  id: BuiltinTools.Bash.id,
  name: BuiltinTools.Bash.name,
  description: `Execute a bash/sh shell command and return stdout, stderr, and exit code.

Safety rules:
- Avoid interactive commands that read from stdin (they will hang).
- Destructive patterns (recursive force-delete, mkfs, fork bombs, etc.) are blocked regardless of permission mode.
- Commands are executed inside the workspace root as the working directory.
- Timeout defaults to 2 minutes; use \`run_in_background: true\` for long-running daemons.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
    bypassImmune: true, // 安全检查即使 bypass 模式也跑
    safetyCheck: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return 'continue';
      const { command } = parsed.data;
      for (const re of BANNED_COMMAND_PATTERNS) {
        if (re.test(command)) return 'deny';
      }
      return 'continue';
    },
  },

  async execute(input: BashInput, ctx: ToolExecutionContext): Promise<BashResult> {
    const { command, timeout, run_in_background } = input;

    // 安全检查在此重复,以便直接分发时也触发
    for (const re of BANNED_COMMAND_PATTERNS) {
      if (re.test(command)) {
        throw new Error(`Command blocked by safety policy: ${command}`);
      }
    }

    const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
    const cwd = ctx.workspaceRoot || process.cwd();
    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const startMs = Date.now();

    // 有 sandbox CommandRunner 时委托 - 获得 OS 级沙箱。
    // run_in_background 也走 CommandRunner,以尊重 sandbox 规则并产出
    // 可追踪任务,而非 detached 孤儿进程。
    if (ctx.commandRunner) {
      const result = await ctx.commandRunner.run(command, {
        cwd,
        timeout: run_in_background ? 0 : timeoutMs,
        signal: ctx.signal,
        background: run_in_background,
      });
      return { ...result, durationMs: Date.now() - startMs };
    }

    if (run_in_background) {
      // 无 CommandRunner - 回退 detached spawn,但仅作最后手段。
      spawn(shell, ['-c', command], { cwd, stdio: 'ignore', detached: true }).unref();
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 0 };
    }

    return runShell(shell, ['-c', command], cwd, timeoutMs, ctx.signal);
  },
});

// ── runShell ─────────────────────────────────────────────────────────────────

/**
 * BashTool 与 PowerShellTool 共用的进程执行薄封装。
 * 真实实现在 @ema-agent/tool spawnProcess。
 */
export async function runShell(
  shell: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BashResult> {
  const startMs = Date.now();
  const result  = await spawnProcess(shell, args, cwd, timeoutMs, signal);
  return { ...result, durationMs: Date.now() - startMs };
}
