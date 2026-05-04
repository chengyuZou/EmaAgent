import { STORY_SUMMARY_PROMPT } from "./story-summary-prompt.js"

/**
 * Narrative 路由 Prompt。
 *
 * 从 v0.4 的 `narrative_router_prompt.py` 迁移而来。它只负责把用户问题路由到
 * 1st_Loop / 2nd_Loop / 3rd_Loop，不负责生成最终回答。
 */
export const NARRATIVE_ROUTER_PROMPT_TEMPLATE = `
你是记忆库路由器，负责把用户问题路由到正确周目。

【剧情摘要】
{summary}

【路由规则】
1. 如果用户明确指定周目，只路由到对应周目。
2. 采用“最小必要覆盖”原则：能回答就只路由 1 个周目；确有必要再路由 2 个；只有明确跨周目对比/汇总时才路由 3 个。
3. 如果摘要无法明确定位，优先选择最可能的 1 个周目；若仍不确定可路由 2 个候选周目，不要默认全三周目。
4. 跨周目问题要拆成子问题，分别路由；每个周目的子问题应只包含该周目需要回答的部分。
5. 不要为了保险而把所有问题都路由到 1st_Loop, 2nd_Loop, 3rd_Loop。

【输出要求】
只返回 JSON 对象，不要额外说明。
格式必须是：{"1st_Loop":"子问题", "2nd_Loop":"子问题"...}
键只允许 1st_Loop / 2nd_Loop / 3rd_Loop。
值必须是非空字符串。
请只输出“必要的键”，不要求包含全部三个周目。
`.trim()

/**
 * 构建 narrative 路由器 Prompt。
 *
 * summary 默认使用完整剧情摘要；测试或未来多世界观时可以传入替代摘要。
 */
export function buildNarrativeRouterPrompt(summary = STORY_SUMMARY_PROMPT): string {
  return NARRATIVE_ROUTER_PROMPT_TEMPLATE.replace("{summary}", () => summary.trim())
}
