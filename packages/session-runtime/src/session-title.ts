/** 会话标题生成相关函数。 */

import type {
  ChatMessage,
  GenerateSessionTitleRequest,
  SessionTitleResult,
  ShouldGenerateTitleRequest,
} from "@ema-agent/core-types";

const DEFAULT_TITLE = "New Chat";
const MAX_TITLE_LEN = 30;

/** 判断当前会话是否需要生成标题。 */
export function shouldGenerateSessionTitle(req: ShouldGenerateTitleRequest): boolean {
  // 只有默认标题状态才自动生成，避免覆盖用户手动标题。
  return req.session.messages.some((message) => message.role === "user") && req.session.titleStatus === "default";
}

/** 生成会话标题。真实 LLM 标题生成接入前，先使用首条用户消息做稳定 fallback。 */
export async function generateSessionTitle(req: GenerateSessionTitleRequest): Promise<SessionTitleResult> {
  const title = createFallbackTitle(req.session.messages);
  return {
    title,
    status: title === DEFAULT_TITLE ? "fallback" : "generated",
  };
}

/** 从消息列表中提取 fallback 标题。 */
export function createFallbackTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return DEFAULT_TITLE;
  }

  return normalizeSessionTitle(firstUserMessage.content);
}

/** 清洗标题，避免换行、空白和过长文本进入侧边栏。 */
export function normalizeSessionTitle(input: string): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return DEFAULT_TITLE;
  }

  return oneLine.length > MAX_TITLE_LEN ? `${oneLine.slice(0, MAX_TITLE_LEN)}...` : oneLine;
}
