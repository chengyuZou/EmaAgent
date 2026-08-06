// AskUserTool 的模型说明书, 单点维护。主体对照 Claude AskUserQuestionTool,
// 按我方事实修正(Plan 未接线, 不引用 ExitPlanMode)。

export const ASK_USER_DESCRIPTION = `Ask the user one or more structured questions and wait for their responses.

Use this tool when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Ask 1–4 questions per call. Each question needs a very short \`header\` label (max 12 chars, shown as a chip).
- Every question must provide 2–4 options with a label and optional description; users always get an "Other" free-text escape hatch automatically — do not add one yourself.
- Use \`multiSelect: true\` to allow multiple answers to be selected for a question.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
- Question texts must be unique within a call, and option labels must be unique within each question.`;
