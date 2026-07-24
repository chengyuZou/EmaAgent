// 向用户提出是非确认，并把确认结果交还给 Agent。
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { ToolExecutionEvent as EmaStreamEvent } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { AskUserPort, BuiltinToolContext } from '../../builtinToolContext.js';
import { contextOk } from '../../contextValidation.js';

/** AskConfirm 工具的窄 Context：可选 SSE 输出 + 可选问询解析器 + 调用身份。 */
interface AskConfirmToolContext {
  emit?: (event: EmaStreamEvent) => void;
  askUser?: AskUserPort;
  sessionId: SessionId;
  turnId: TurnId;
  signal: AbortSignal;
}

const inputSchema = z.object({
  question: z.string().min(1).describe('The yes/no question to present to the user.'),
  humanDescription: z.string().optional().describe('Optional plain-language context shown above the question.'),
});

type AskConfirmInput = z.infer<typeof inputSchema>;

export interface AskConfirmResult {
  confirmed: boolean;
}

export const AskConfirmTool = buildTool<AskConfirmInput, AskConfirmResult, BuiltinToolContext, AskConfirmToolContext>({
  id: BuiltinTools.AskConfirm.id,
  name: BuiltinTools.AskConfirm.name,
  description: `Ask the user a single yes/no confirmation question and wait for their response.

Use this when you need explicit approval before a consequential action. Returns { confirmed: true/false }.
Prefer this over AskUser when you only need a binary decision - the UI shows a focused confirm dialog.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  requiresUserInteraction: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  // 总是可用：有 emit+askUser 走 SSE，否则 CLI 兜底。
  validateContext(ctx) {
    return contextOk({
      ...(ctx.emit ? { emit: ctx.emit } : {}),
      ...(ctx.askUser ? { askUser: ctx.askUser } : {}),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      signal: ctx.signal,
    });
  },

  async execute(
    input: AskConfirmInput,
    context: AskConfirmToolContext,
  ): Promise<AskConfirmResult> {
    if (context.emit && context.askUser) {
      const promptId = randomUUID();
      const request = {
        type:             'ask_confirm_required',
        sessionId:        context.sessionId,
        turnId:           context.turnId,
        promptId,
        question:         input.question,
        humanDescription: input.humanDescription,
      } satisfies EmaStreamEvent;
      context.emit(request);

      const { answers } = await context.askUser(promptId, [], request);
      const confirmed = answers['confirmed'] === 'true';

      context.emit({
        type:      'ask_confirm_resolved',
        sessionId: context.sessionId,
        promptId,
        confirmed,
      } satisfies EmaStreamEvent);

      return { confirmed };
    }

    // CLI 兜底
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    context.signal.addEventListener('abort', () => rl.close(), { once: true });
    const answer = await rl.question(`\n${input.question} (y/n): `);
    rl.close();
    return { confirmed: answer.trim().toLowerCase() === 'y' };
  },
});
