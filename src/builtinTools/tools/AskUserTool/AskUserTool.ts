// 一次向用户提出一个或多个结构化问题，并等待统一回答。
// 模型说明书见 prompt.ts。问询通道由 AskUserPort 抽象:
// 事件发射(ask_user_required/resolved)归 port 实现, Tool 不触碰事件总线。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type AskUserPort,
  type ToolInvocation,
} from '@ema-agent/tools';
import type { AskUserQuestionSpec } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { ASK_USER_DESCRIPTION } from './prompt.js';

/** AskUser 工具的窄 Context：只取问询解析器;身份与取消走 ToolInvocation。 */
interface AskUserToolContext {
  askUser: AskUserPort;
}

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
          .describe(
            'Multiple-choice options (2–4, required). Users always get an "Other" '
            + 'free-text escape hatch automatically — do not add one yourself.',
          ),
        multiSelect: z
          .boolean()
          .default(false)
          .describe('Allow multiple options to be selected.'),
      }),
    )
    .min(1)
    .max(4)
    .describe('Questions to ask (1–4).'),
}).superRefine((value, ctx) => {
  // Claude 同款唯一性: 问题文本不可重复;同题内选项 label 不可重复。
  const seen = new Set<string>();
  value.questions.forEach((q, qi) => {
    if (seen.has(q.question)) {
      ctx.addIssue({ code: 'custom', path: ['questions', qi, 'question'], message: 'Question texts must be unique.' });
    }
    seen.add(q.question);
    const labels = new Set<string>();
    q.options.forEach((o, oi) => {
      if (labels.has(o.label)) {
        ctx.addIssue({ code: 'custom', path: ['questions', qi, 'options', oi, 'label'], message: 'Option labels must be unique within a question.' });
      }
      labels.add(o.label);
    });
  });
});

type AskUserInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

/** 答案以问题文本为键(模型可读);前端卡片按 spec id 回答, Tool 负责映射。 */
export interface AskUserResult {
  answers: Record<string, string>;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const AskUserTool = buildTool<AskUserInput, AskUserResult, AskUserToolContext>({
  id: BuiltinTools.AskUser.id,
  name: BuiltinTools.AskUser.name,
  description: ASK_USER_DESCRIPTION,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  requiresUserInteraction: () => true,

  // 没有问询通道的宿主不暴露此工具(桌面宠物没有 stdin 兜底)。
  validateContext(ctx) {
    if (!ctx.askUser) {
      return contextFail('当前宿主没有 AskUser 问询通道。');
    }
    return contextOk({ askUser: ctx.askUser });
  },

  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),

  async execute(
    input: AskUserInput,
    context: AskUserToolContext,
    invocation: ToolInvocation,
  ): Promise<AskUserResult> {
    const promptId = randomUUID();
    const specs: AskUserQuestionSpec[] = input.questions.map((q, i) => ({
      id:          `q${i}`,
      question:    q.question,
      header:      q.header,
      options:     q.options,
      multiSelect: q.multiSelect,
    }));
    const request = {
      type: 'ask_user_required',
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      promptId,
      questions: specs,
    } as const;

    // port 返回答案以 spec id 为键;模型看到的是问题文本键。
    // resolved 事件形状是本 Tool 专属的,工厂交给 port 在结算点发射。
    const result = await context.askUser(
      promptId,
      specs,
      request,
      (answers) => ({
        type: 'ask_user_resolved',
        sessionId: invocation.sessionId,
        promptId,
        answers,
      }),
    );
    const answers: Record<string, string> = {};
    for (const spec of specs) {
      const byId = result.answers[spec.id];
      const byQuestion = result.answers[spec.question];
      answers[spec.question] = byId ?? byQuestion ?? '';
    }
    return { answers };
  },

  mapResultToModelContent(output) {
    const lines = Object.entries(output.answers).map(
      ([question, answer]) => `Q: ${question}\nA: ${answer || '(no answer)'}`,
    );
    return lines.length > 0 ? lines.join('\n') : 'User answered with no content.';
  },
});
