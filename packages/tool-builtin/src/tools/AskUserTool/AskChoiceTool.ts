// 这个工具负责向用户展示一组明确选项，并等待用户选择后继续 Agent。
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { SessionId, TurnId } from '@ema-agent/contracts';
import type { EmaStreamEvent } from '@ema-agent/turn';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

const inputSchema = z.object({
  question: z.string().min(1).describe('The question to ask the user.'),
  humanDescription: z.string().optional().describe('Optional plain-language context shown above the options.'),
  options: z
    .array(z.object({
      label:       z.string().min(1),
      description: z.string().optional().describe('Short explanation of this option.'),
    }))
    .min(2)
    .max(8)
    .describe('Choices to present (2–8 options).'),
  multiSelect: z.boolean().default(false).describe('Allow the user to select multiple options.'),
  allowCustom: z.boolean().default(false).describe('Show a free-text "Other" input below the options.'),
});

type AskChoiceInput = z.infer<typeof inputSchema>;

export interface AskChoiceResult {
  /** 选中项的 label。单选:始终一项。 */
  selected: string[];
  /** allowCustom=true 且用户输入自定义答案时填入。 */
  customText?: string;
}

export const AskChoiceTool = buildTool<AskChoiceInput, AskChoiceResult>({
  id: BuiltinTools.AskChoice.id,
  name: BuiltinTools.AskChoice.name,
  description: `Present the user with a list of options and wait for their selection.

Use this when you need the user to pick from a known set of choices (2–8 options).
Set multiSelect=true to allow picking multiple. Set allowCustom=true to allow a free-text "Other" answer.
Prefer this over AskUser for a single choice question - the UI shows a cleaner selection card.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input: AskChoiceInput, ctx: ToolExecutionContext): Promise<AskChoiceResult> {
    if (ctx.emit && ctx.askUser) {
      const promptId = randomUUID();
      const request = {
        type:             'ask_choice_required',
        sessionId:        ctx.sessionId as SessionId,
        turnId:           ctx.turnId as TurnId,
        promptId,
        question:         input.question,
        humanDescription: input.humanDescription,
        options:          input.options,
        multiSelect:      input.multiSelect,
        allowCustom:      input.allowCustom,
      } satisfies EmaStreamEvent;
      ctx.emit(request);

      const { answers } = await ctx.askUser(promptId, [], request);
      // 前端提交:{ selected: 'label1,label2', custom?: 'text' }
      const raw      = answers['selected'] ?? '';
      const selected = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const customText = answers['custom'] || undefined;

      ctx.emit({
        type:      'ask_choice_resolved',
        sessionId: ctx.sessionId as SessionId,
        promptId,
        selected,
        customText,
      } satisfies EmaStreamEvent);

      return { selected, customText };
    }

    // CLI 兜底
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ctx.signal.addEventListener('abort', () => rl.close(), { once: true });
    const list = input.options.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');
    const answer = await rl.question(`\n${input.question}\n${list}\nSelect (number${input.multiSelect ? 's, comma-separated' : ''}): `);
    rl.close();
    const indices = answer.split(',').map((s) => parseInt(s.trim(), 10) - 1).filter((i) => i >= 0 && i < input.options.length);
    return { selected: indices.map((i) => input.options[i]!.label) };
  },
});
