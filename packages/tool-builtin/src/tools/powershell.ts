import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';
import { runShell, type BashResult } from './bash.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const BANNED_COMMAND_PATTERNS: RegExp[] = [
  /Remove-Item\s+.*-Recurse.*-Force/i,
  /Format-Volume\b/i,
  /:\(\)\{\s*:\|:\s*&\s*\};:/,
  /rm\s+(-rf|--recursive\s+--force)\b/i,
];

// ── Input schema ──────────────────────────────────────────────────────────────

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

// ── Tool definition ───────────────────────────────────────────────────────────

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

    if (ctx.commandRunner) {
      return ctx.commandRunner.run(command, { cwd: ctx.workspaceRoot, timeout: timeoutMs, signal: ctx.signal });
    }

    return runShell(
      'powershell.exe',
      ['-NonInteractive', '-Command', command],
      ctx.workspaceRoot,
      timeoutMs,
      ctx.signal,
    );
  },
});
