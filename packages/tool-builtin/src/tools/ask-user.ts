import * as readline from 'node:readline/promises';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Input schema ──────────────────────────────────────────────────────────────

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

// ── Output type ───────────────────────────────────────────────────────────────

export interface AskUserResult {
  answers: Record<string, string>;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const askUserTool = buildTool<AskUserInput, AskUserResult>({
  name: 'ask_user',
  description: `Ask the user one or more questions and wait for their responses.

- In desktop (Tauri) mode: emits a \`permission_required\`-style SSE event; the frontend shows a dialog and the response is delivered back via the SSE channel.
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
      // Desktop / SSE path — emit a structured event and wait for the answer
      // to come back through a side-channel promise resolved by the orchestrator.
      // The orchestrator injects an `askUser` resolver into ctx for this purpose.
      const askFn = (ctx as unknown as { askUser?: AskFn }).askUser;
      if (askFn) {
        return askFn(questions);
      }
    }

    // CLI fallback — read answers from stdin line by line
    return cliAsk(questions, ctx.signal);
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────

type QuestionDef = AskUserInput['questions'][number];
type AskFn = (questions: QuestionDef[]) => Promise<AskUserResult>;

// ── CLI stdin path ────────────────────────────────────────────────────────────

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
