export const TIMELINES = ['1st_Loop', '2nd_Loop', '3rd_Loop'] as const;
// 构建剧情数据时用的 Pro/bge-m3 维度为1024
export const EMBEDDING_DIM = 1024;
/** 实体/关系各自的初始向量候选数, 图扩展之后可能得到更多节点或边. */
export const TOP_K = 40;
/** 每周目进入重排的正文候选数. */
export const CHUNK_TOP_K = 20;
// 图限制用于来源选块; MAX_CONTEXT_CHARACTERS 是整次查询原文的预算, 各周目均分.
// 单位是 JavaScript 字符串 .length, 不是 token.
export const MAX_ENTITY_CHARACTERS = 18_000;
export const MAX_RELATION_CHARACTERS = 24_000;
export const MAX_CONTEXT_CHARACTERS = 32_000;
/** 每周目最多返回八块原文, 同时受整次查询的字符预算限制. */
export const RERANK_TOP_K = 8;

/** 原始余弦分数, 不是答案正确率; 图已找到的来源块只排名, 不使用此门槛. */
export const COSINE_THRESHOLD = 0.2;
/** 来源组的选块数量系数, 以及无向量时每组分配的上限; 不是最终正文总数. */
export const RELATED_CHUNK_NUMBER = 5;
