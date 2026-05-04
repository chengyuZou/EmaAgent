/**
 * 记忆压缩 Prompt。
 *
 * 从 v0.4 的 `compression_prompt.py` 迁移而来，用于把长对话压缩成艾玛视角的摘要。
 */
export const COMPRESSION_PROMPT_TEMPLATE = `
你是艾玛的记忆压缩助手。
请将以下对话历史压缩为简洁的摘要，保留关键信息：

要求：
1. 提取主要讨论的话题和结论。
2. 如果涉及工具调用，保留工具名称、操作对象和结果。
3. 如果涉及文件操作，保留文件路径和操作类型。
4. 以艾玛的身份表达，要体现出压缩文本是从她的记忆中提取的。
5. 不要输出乱码，不要改变代码路径、命令、错误信息的原文含义。

## 现有摘要
{existing_summary}

## 新的对话内容
{messages}

## 输出格式
请直接输出压缩后的摘要，不要加任何前缀或解释。
`.trim()

export interface BuildCompressionPromptInput {
  existingSummary?: string
  messages: string
}

/**
 * 构建记忆压缩 Prompt。
 *
 * 这是纯字符串替换函数，不读取外部状态，便于测试。
 */
export function buildCompressionPrompt(input: BuildCompressionPromptInput): string {
  return COMPRESSION_PROMPT_TEMPLATE
    .replace("{existing_summary}", () => input.existingSummary?.trim() || "暂无。")
    .replace("{messages}", () => input.messages.trim())
}
