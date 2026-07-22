// 这个工具负责向用户请求一段自由文本，并等待输入后继续 Agent。
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/turn';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

const inputSchema = z.object({
  question:         z.string().min(1).describe('The question to ask the user.'),
  humanDescription: z.string().optional().describe('Optional plain-language context shown above the input.'),
  placeholder:      z.string().optional().describe('Placeholder hint shown inside the text input.'),
});

type AskTextInput = z.infer<typeof inputSchema>;

export interface AskTextResult {
  text: string;
}

export const AskTextTool = buildTool<AskTextInput, AskTextResult>({
  id: BuiltinTools.AskText.id,
  name: BuiltinTools.AskText.name,
  description: `Ask the user a single open-ended question and wait for a free-text answer.

Use this when you need a short string response from the user (a name, a path, a description, etc.).
Prefer this over AskUser for a single freeform question - the UI shows a focused text input.`,

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
      const request = {
        type:             'ask_text_required',
        sessionId:        ctx.sessionId as SessionId,
        turnId:           ctx.turnId as TurnId,
        promptId,
        question:         input.question,
        humanDescription: input.humanDescription,
        placeholder:      input.placeholder,
      } satisfies EmaStreamEvent;
      ctx.emit(request);

      const { answers } = await ctx.askUser(promptId, [], request);
      const text = answers['text'] ?? '';

      ctx.emit({
        type:      'ask_text_resolved',
        sessionId: ctx.sessionId as SessionId,
        promptId,
        text,
      } satisfies EmaStreamEvent);

      return { text };
    }

    // CLI 兜底
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ctx.signal.addEventListener('abort', () => rl.close(), { once: true });
    const text = await rl.question(`\n${input.question}\nAnswer: `);
    rl.close();
    return { text: text.trim() };
  },
});
