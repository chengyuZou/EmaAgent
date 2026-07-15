import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';

const inputSchema = z.object({
  question: z.string().min(1).describe('The yes/no question to present to the user.'),
  humanDescription: z.string().optional().describe('Optional plain-language context shown above the question.'),
});

type AskConfirmInput = z.infer<typeof inputSchema>;

export interface AskConfirmResult {
  confirmed: boolean;
}

export const askConfirmTool = buildTool<AskConfirmInput, AskConfirmResult>({
  name: 'ask_confirm',
  description: `Ask the user a single yes/no confirmation question and wait for their response.

Use this when you need explicit approval before a consequential action. Returns { confirmed: true/false }.
Prefer this over ask_user when you only need a binary decision - the UI shows a focused confirm dialog.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input: AskConfirmInput, ctx: ToolExecutionContext): Promise<AskConfirmResult> {
    if (ctx.emit && ctx.askUser) {
      const promptId = randomUUID();
      ctx.emit({
        type:             'ask_confirm_required',
        sessionId:        ctx.sessionId as SessionId,
        turnId:           ctx.turnId as TurnId,
        promptId,
        question:         input.question,
        humanDescription: input.humanDescription,
      } satisfies EmaStreamEvent);

      const { answers } = await ctx.askUser(promptId, []);
      const confirmed = answers['confirmed'] === 'true';

      ctx.emit({
        type:      'ask_confirm_resolved',
        sessionId: ctx.sessionId as SessionId,
        promptId,
        confirmed,
      } satisfies EmaStreamEvent);

      return { confirmed };
    }

    // CLI 兜底
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ctx.signal.addEventListener('abort', () => rl.close(), { once: true });
    const answer = await rl.question(`\n${input.question} (y/n): `);
    rl.close();
    return { confirmed: answer.trim().toLowerCase() === 'y' };
  },
});
