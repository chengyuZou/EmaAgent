export const TIMELINES = ['1st_Loop', '2nd_Loop', '3rd_Loop'] as const;
// 构建剧情数据时用的 Pro/bge-m3 维度为1024
export const EMBEDDING_DIM = 1024;
export const KEYWORD_LANGUAGE = 'English';
/** 实体/关系各自的初始向量候选数, 图扩展之后可能得到更多节点或边. */
export const TOP_K = 40;
/** 直接块搜索的候选数, 也是最终正文的最大块数. */
export const CHUNK_TOP_K = 20;
// 每个周目分别限制返回字符串的长度(.length), 包括 JSON 转义和格式文本.
// 上限取原生 token 数值的三倍, 不是实际 token 数或模型输出预算.
export const MAX_ENTITY_CHARACTERS = 18_000;
export const MAX_RELATION_CHARACTERS = 24_000;
export const MAX_CONTEXT_CHARACTERS = 90_000;

/** 原始余弦分数, 不是答案正确率; 图已找到的来源块只排名, 不使用此门槛. */
export const COSINE_THRESHOLD = 0.2;
/** 来源组的选块数量系数, 以及无向量时每组分配的上限; 不是最终正文总数. */
export const RELATED_CHUNK_NUMBER = 5;
/** 按 Unicode 字符计数. 仅短问题在提词为空时可临时当作具体关键词, 不将长问题整段用于实体搜索. */
export const EMPTY_KEYWORDS_QUERY_LIMIT = 50;
