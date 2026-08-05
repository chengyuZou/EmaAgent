// FileReadTool 的全部结果预算与取值理由; prompt 文案与执行代码从同一处引用。

/**
 * 单次读取给模型的正文字节预算。
 * 超出部分标 truncated + nextOffset 翻页——分页续读比直接拒绝更省 token
 * (拒绝 = 错误 + 再次完整调用; 翻页 = 确定的增量)。Claude 的实验同结论:
 * 超限 throw 会让平均 token 上涨(见 claude-code FileReadTool/limits.ts 注)。
 */
export const SELECTED_BYTES_LIMIT = 50 * 1024;

/** 工具级结果预算: 正文预算 + cat -n 行号开销余量, 与 reader 截断口径严格一致。 */
export const MAX_RESULT_BYTES = SELECTED_BYTES_LIMIT + 16 * 1024;

/** 单次分页最多行数: 防止 limit=天文数字制造巨量输出。 */
export const MAX_READ_LINES = 2000;

/** 超过此体积的文本只允许分页读取(流式), 整读直接拒绝。 */
export const TEXT_WHOLE_READ_LIMIT = 10 * 1024 * 1024;

/** 图片原文件上限: 取各 Provider 图片限制的保守下限(Anthropic ~5MB)。 */
export const IMAGE_FILE_SIZE_LIMIT = 5 * 1024 * 1024;
