import * as readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { AskUserQuestionSpec, EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).describe('The question to ask the user.'),
        header: z
          .string()
          .max(12)
          .describe('Very short label (max 12 chars) shown as a chip/tag.'),
        options: z
          .array(
            z.object({
              label: z.string().min(1),
              description: z.string().optional(),
            }),
          )
          .min(2)
          .max(4)
          .optional()
          .describe('Multiple-choice options (2–4). Omit for freeform text answer.'),
        multiSelect: z
          .boolean()
          .default(false)
          .describe('Allow multiple options to be selected.'),
      }),
    )
    .min(1)
    .max(4)
    .describe('Questions to ask (1–4).'),
});

type AskUserInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface AskUserResult {
  answers: Record<string, string>;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const askUserTool = buildTool<AskUserInput, AskUserResult>({
  name: 'ask_user',
  description: `Ask the user one or more questions and wait for their responses.

- In desktop (Tauri) mode: emits an \`ask_user_required\` SSE event; the frontend shows a dialog and the response is delivered back via the per-turn SSE channel.
- In CLI mode: reads answers from stdin.
- Up to 4 questions per call. For multiple-choice questions, provide 2–4 options.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input: AskUserInput, ctx: ToolExecutionContext): Promise<AskUserResult> {
    const { questions } = input;

    if (ctx.emit) {
      // Desktop / SSE 路径 - emit 结构化事件,等答案经 side-channel promise
      // 回来(由 orchestrator resolve)。orchestrator 为此向 ctx 注入 `askUser` resolver。
      if (ctx.askUser) {
        const askFn = ctx.askUser;
        const promptId = randomUUID();
        const specs: AskUserQuestionSpec[] = questions.map((q, i) => ({
          id:          `q${i}`,
          question:    q.question,
          header:      q.header,
          options:     q.options,
          multiSelect: q.multiSelect,
        }));
        ctx.emit({ type: 'ask_user_required', sessionId: ctx.sessionId as SessionId, turnId: ctx.turnId as TurnId, promptId, questions: specs });
        try {
          const result = await askFn(promptId, specs);
          ctx.emit({ type: 'ask_user_resolved', sessionId: ctx.sessionId as SessionId, promptId, answers: result.answers });
          return result;
        } catch (err: unknown) {
          // 即使中止也 emit resolved 事件,让前端能清 modal。
          ctx.emit({ type: 'ask_user_resolved', sessionId: ctx.sessionId as SessionId, promptId, answers: {} });
          throw err;
        }
      }
    }

    // CLI 兜底 - 从 stdin 逐行读答案
    return cliAsk(questions, ctx.signal);
  },
});

// ── 类型 ─────────────────────────────────────────────────────────────────────

type QuestionDef = AskUserInput['questions'][number];

// ── CLI stdin 路径 ────────────────────────────────────────────────────────────

async function cliAsk(questions: QuestionDef[], signal: AbortSignal): Promise<AskUserResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  signal.addEventListener('abort', () => rl.close(), { once: true });

  const answers: Record<string, string> = {};
  for (const q of questions) {
    let prompt = `\n${q.question}`;
    if (q.options) {
      prompt += '\n' + q.options.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n') + '\nAnswer: ';
    } else {
      prompt += '\nAnswer: ';
    }
    const answer = await rl.question(prompt);
    answers[q.question] = answer.trim();
  }
  rl.close();
  return { answers };
}
