
/** 文本正文预算, 不含行号. 超出时返回已读完整行和 nextOffset. */
export const SELECTED_BYTES_LIMIT = 50 * 1024;

/** 文本结果预留行号开销; 工具输出层仍会检查最终序列化体积. */
export const MAX_RESULT_BYTES = SELECTED_BYTES_LIMIT + 16 * 1024;

/** 单次分页最多行数: 防止 limit=天文数字制造巨量输出. */
export const MAX_READ_LINES = 2000;

/** 超过此体积的文本只允许分页读取(流式), 整读直接拒绝. */
export const TEXT_WHOLE_READ_LIMIT = 10 * 1024 * 1024;

/** 本工具接受的图片文件体积上限, 不代表所有 Provider 都接受该体积. */
export const IMAGE_FILE_SIZE_LIMIT = 5 * 1024 * 1024;

/** Notebook 会整份 JSON.parse, 因此限制输入文件体积. */
export const NOTEBOOK_SIZE_LIMIT = 50 * 1024 * 1024;

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PDF_PAGE_COUNT = 10;
export const MAX_PDF_PAGE_COUNT = 20;
export const PDF_RESULT_BYTES_LIMIT = 150_000;
