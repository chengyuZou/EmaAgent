// 从用户首条输入生成 Session 短标题；模型不可用时截断原文兜底。

const TITLE_PROMPT = `为下面的内容生成一个 7 到 15 字的简短标题，只输出标题本身，不加引号和书名号。\n\n内容：`;
/** 模型输出的保险上限；指令目标是 7–15 字，偶发超长在这里截断。 */
const TITLE_GENERATED_MAX_CHARS = 60;
/** 兜底路径保留的原文长度。 */
const TITLE_FALLBACK_MAX_CHARS = 100;
const TITLE_INPUT_MAX_CHARS = 400;

/** 单次标题补全能力：扔进去 prompt，扔出来标题候选；由装配层用真实 LLM 绑定。 */
export type SessionTitleCompletion = (prompt: string) => Promise<string | undefined>;

/**
 * 输入用户 query，返回可用标题；空输入返回空串（调用方跳过写入）。
 * 持久化不在此发生——调用方拿返回值走 `SessionStore.updateTitle`。
 */
export async function generateSessionTitle(
  query: string,
  complete: SessionTitleCompletion,
): Promise<string> {
  const cleaned = query.trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';

  try {
    const generated = await complete(TITLE_PROMPT + cleaned.slice(0, TITLE_INPUT_MAX_CHARS));
    const normalized = generated?.trim().replace(/^["'《「]|["'》」]$/g, '');
    if (normalized) return normalized.slice(0, TITLE_GENERATED_MAX_CHARS);
  } catch {
    // 标题生成不能阻断会话；模型失败时回退为原文截断。
  }

  return cleaned.length <= TITLE_FALLBACK_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, TITLE_FALLBACK_MAX_CHARS - 1)}…`;
}
