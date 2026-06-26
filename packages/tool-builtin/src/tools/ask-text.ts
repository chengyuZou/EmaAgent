import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';

const inputSchema = z.object({
  question:         z.string().min(1).describe('The question to ask the user.'),
  humanDescription: z.string().optional().describe('Optional plain-language context shown above the input.'),
  placeholder:      z.string().optional().describe('Placeholder hint shown inside the text input.'),
});

type AskTextInput = z.infer<typeof inputSchema>;

export interface AskTextResult {
  text: string;
}

export const askTextTool = buildTool<AskTextInput, AskTextResult>({
  name: 'ask_text',
  description: `Ask the user a single open-ended question and wait for a free-text answer.

Use this when you need a short string response from the user (a name, a path, a description, etc.).
Prefer this over ask_user for a single freeform question — the UI shows a focused text input.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input: AskTextInput, ctx: ToolExecutionContext): Promise<AskTextResult> {
    if (ctx.emit && ctx.askUser) {
      const promptId = randomUUID();
      ctx.emit({
        type:             'ask_text_required',
        sessionId:        ctx.sessionId as SessionId,
        turnId:           ctx.turnId as TurnId,
        promptId,
        question:         input.question,
        humanDescription: input.humanDescription,
        placeholder:      input.placeholder,
      } satisfies EmaStreamEvent);

      const { answers } = await ctx.askUser(promptId, []);
      const text = answers['text'] ?? '';

      ctx.emit({
        type:      'ask_text_resolved',
        sessionId: ctx.sessionId as SessionId,
        promptId,
        text,
      } satisfies EmaStreamEvent);

      return { text };
    }

    // CLI fallback
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ctx.signal.addEventListener('abort', () => rl.close(), { once: true });
    const text = await rl.question(`\n${input.question}\nAnswer: `);
    rl.close();
    return { text: text.trim() };
  },
});
