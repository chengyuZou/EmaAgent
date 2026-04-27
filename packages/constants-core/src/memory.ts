/**
 * 记忆子系统的不可配置常量。
 */

/** 工作记忆保留的最近消息条数 */
export const WORKING_MEMORY_WINDOW_SIZE = 10;

/** 默认向量/关键词召回条数 */
export const MEMORY_RECALL_TOPK = 5;

/** 注入到 prompt 中的记忆上下文最大字符预算（中文约 1 token = 1.5 字符） */
export const MEMORY_CONTEXT_BUDGET_CHARS = 3_000;
