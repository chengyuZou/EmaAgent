// 向用户请求一段自由文本，并等待输入后继续 Agent。
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { ToolExecutionEvent } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { AskUserPort, BuiltinToolContext } from '../../builtinToolContext.js';
import { contextOk } from '../../contextValidation.js';

/** AskText 工具的窄 Context：可选 SSE 输出 + 可选问询解析器 + 调用身份。 */
interface AskTextToolContext {
  emit?: (event: ToolExecutionEvent) => void;
  askUser?: AskUserPort;
  sessionId: SessionId;
  turnId: TurnId;
  signal: AbortSignal;
}

const inputSchema = z.object({
  question:         z.string().min(1).describe('The question to ask the user.'),
  humanDescription: z.string().optional().describe('Optional plain-language context shown above the input.'),
  placeholder:      z.string().optional().describe('Placeholder hint shown inside the text input.'),
});

type AskTextInput = z.infer<typeof inputSchema>;

export interface AskTextResult {
  text: string;
}

export const AskTextTool = buildTool<AskTextInput, AskTextResult, BuiltinToolContext, AskTextToolContext>({
  id: BuiltinTools.AskText.id,
  name: BuiltinTools.AskText.name,
  description: `Ask the user a single open-ended question and wait for a free-text answer.

Use this when you need a short string response from the user (a name, a path, a description, etc.).
Prefer this over AskUser for a single freeform question - the UI shows a focused text input.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  requiresUserInteraction: () => true,
  requires: ['askUser'],

  permissionMeta: {
    approval: 'not_required',
    riskLevel: 'low',
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
    input: AskTextInput,
    context: AskTextToolContext,
  ): Promise<AskTextResult> {
    if (context.emit && context.askUser) {
      const promptId = randomUUID();
      const request = {
        type:             'ask_text_required',
        sessionId:        context.sessionId,
        turnId:           context.turnId,
        promptId,
        question:         input.question,
        humanDescription: input.humanDescription,
        placeholder:      input.placeholder,
      } satisfies ToolExecutionEvent;
      context.emit(request);

      try {
        const { answers } = await context.askUser(promptId, [], request);
        const text = answers['text'] ?? '';

        context.emit({
          type:      'ask_text_resolved',
          sessionId: context.sessionId,
          promptId,
          text,
        } satisfies ToolExecutionEvent);

        return { text };
      } catch (error) {
        // resolved 只负责清理前端卡片；异常继续抛出，不能成为成功的空文本。
        context.emit({
          type:      'ask_text_resolved',
          sessionId: context.sessionId,
          promptId,
          text:      '',
        } satisfies ToolExecutionEvent);
        throw error;
      }
    }

    // CLI 兜底
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    context.signal.addEventListener('abort', () => rl.close(), { once: true });
    const text = await rl.question(`\n${input.question}\nAnswer: `);
    rl.close();
    return { text: text.trim() };
  },
});
