export const TIMELINES = ['1st_Loop', '2nd_Loop', '3rd_Loop'] as const;
// 固定剧情资产使用 Pro/BAAI/bge-m3 的 1024 维向量, 查询必须使用相同向量空间.
export const EMBEDDING_DIM = 1024;
/** 实体/关系各自的初始向量候选数, 图扩展之后可能得到更多节点或边. */
export const TOP_K = 40;
/** naive/mix 直接原文向量搜索的候选数, 不限制合并后的图来源候选或重排返回数量. */
export const VECTOR_CHUNK_TOP_K = 100;
/** 每周目合并候选按现有顺序保留的重排输入上限, 不是全局相关性排名. */
export const RERANK_CANDIDATE_LIMIT = 125;
/** 每周目请求的重排结果上限, 最终正文还受字符预算限制. */
export const RERANK_TOP_K = 30;
// 整次查询原文的 UTF-16 码元预算, 各周目均分, 不是 token 或重排输入限制.
export const MAX_CONTEXT_CHARACTERS = 32_000;

/** 原始余弦分数, 不是答案正确率; 图已找到的来源块只排名, 不使用此门槛. */
export const COSINE_THRESHOLD = 0.2;
/** 来源组的选块数量系数, 以及无向量时每组分配的上限; 不是最终正文总数. */
export const RELATED_CHUNK_NUMBER = 5;
