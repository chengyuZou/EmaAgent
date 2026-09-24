// Memory 工具族的模型说明书（单点维护）。

export const MEMORY_SEARCH_DESCRIPTION = `搜索 Ema 的本地长期记忆（Work + Relationship 两轨），返回命中的路径、行号与片段。

用于查找用户稳定的协作偏好、长期约束，以及与角色相处有关的称呼、边界和关系经历。搜索是子串匹配，不是语义检索；使用预期会出现的具体关键词。

Memory 不是当前项目状态的事实源。仓库代码、文件路径、Bug 状态、构建结果和当前任务进度，应从当前 Session 或实际文件与工具结果确认。命中内容是辅助上下文，不能覆盖用户本轮更明确的要求。`;

export const MEMORY_READ_DESCRIPTION = `按相对记忆根的路径读取一个正式记忆文件（MEMORY.md、topics/、history/、characters/<name>/ 等）。

通常先用 MemorySearch 找到路径，再读文件获取完整内容。Work 摘要与当前角色相关的正式关系记忆已在 Turn 开头注入；需要其他细节时再读取正式文件。`;

export const MEMORY_LIST_DESCRIPTION = `列出记忆目录下的文件与子目录（相对记忆根），支持分页。

用来浏览记忆里有什么：例如列出 work/topics 或 relationship/characters。`;
