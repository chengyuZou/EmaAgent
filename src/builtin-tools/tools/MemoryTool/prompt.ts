export const MEMORY_SEARCH_DESCRIPTION = `搜索 EmaAgent 的本地长期记忆(Work + Relationship 两轨),返回命中的路径,行号与片段.

Work 保存用户稳定的工作偏好,协作习惯,工作约定与长期约束.Relationship 保存稳定的用户背景与相处偏好,用户与角色之间的称呼,边界,约定和经历,也保存有对话证据或用户明确设定的角色间关系与共同事件.

按所需信息选择 work 或 relationship 路径;需要同时查两类信息时可以不限定路径.搜索是子串匹配,不是语义检索;使用预期会出现的具体关键词.

Memory 不是当前项目状态的事实源.仓库代码,文件路径,Bug 状态,构建结果和当前任务进度,应从当前 Session 或实际文件与工具结果确认.命中内容是辅助上下文,不能覆盖用户本轮更明确的要求.`;

export const MEMORY_READ_DESCRIPTION = `按相对记忆根的路径读取一个正式记忆文件(MEMORY.md,topics/,history/,characters/<name>/ 等).

Work 的 MEMORY.md 与 topics 保存工作偏好和约束;Relationship 的 shared_user_memory.md 保存共享用户信息,character_relations.md 保存角色间关系与共同事件,characters/<name>/ 下保存用户与角色的相处信息和历史.

使用已知的相对路径,或本轮可用的记忆搜索,目录工具返回的路径.只有当前上下文实际包含的记忆才算已提供;没有对应内容时不能假定已经读过.已有内容足够时不重复读取,需要其他细节时再读取正式文件.`;

export const MEMORY_LIST_DESCRIPTION = `列出记忆目录下的文件与子目录(相对记忆根),支持分页.

用于不知道具体记忆文件名时查看相关目录.工作偏好与协作约定从 work 查找,用户背景,相处信息和角色间关系从 relationship 查找.`;
