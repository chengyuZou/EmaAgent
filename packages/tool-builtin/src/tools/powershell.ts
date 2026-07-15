import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { runShell, type BashResult } from './bash.js';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const BANNED_COMMAND_PATTERNS: RegExp[] = [
  /Remove-Item\s+.*-Recurse.*-Force/i,
  /Format-Volume\b/i,
  /:\(\)\{\s*:\|:\s*&\s*\};:/,
  /rm\s+(-rf|--recursive\s+--force)\b/i,
];

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      'PowerShell command to execute. Avoid interactive cmdlets (Read-Host, Out-GridView, etc.).',
    ),
  description: z
    .string()
    .optional()
    .describe('Brief description shown in permission dialogs.'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}. Max ${MAX_TIMEOUT_MS}.`),
});

type PowerShellInput = z.infer<typeof inputSchema>;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const powershellTool = buildTool<PowerShellInput, BashResult>({
  name: 'powershell',
  description: `Execute a Windows PowerShell command.

- Uses \`powershell.exe -NonInteractive -Command\` so interactive prompts error immediately.
- Destructive patterns (Remove-Item -Recurse -Force, Format-Volume, etc.) are blocked.
- Working directory is the workspace root.
- Only available on Windows (throws on other platforms).`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
    bypassImmune: true,
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

  async execute(input: PowerShellInput, ctx: ToolExecutionContext) {
    if (process.platform !== 'win32') {
      throw new Error('powershell tool is only available on Windows.');
    }

    const { command, timeout } = input;

    for (const re of BANNED_COMMAND_PATTERNS) {
      if (re.test(command)) {
        throw new Error(`Command blocked by safety policy: ${command}`);
      }
    }

    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // 原生 PowerShell 目前无法被 CommandRunner 包裹:V1 sandbox 后端面向
    // Unix shell,CommandRunner 在 Windows 上选 bash。故 apps/core 在 shell
    // 执行会降级为 app-layer 后端时隐藏此工具。
    return runShell(
      'powershell.exe',
      ['-NonInteractive', '-Command', command],
      ctx.workspaceRoot || process.cwd(),
      timeoutMs,
      ctx.signal,
    );
  },
});
