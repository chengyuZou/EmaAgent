// PdfReadTool 的页数与体积上限; prompt 与代码同源引用。

/** 单个 PDF 的文件体积上限。 */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** 未指定 page_count 时的默认读取页数。 */
export const DEFAULT_PAGE_COUNT = 10;
/** 单次调用最多读取页数。 */
export const MAX_PAGE_COUNT = 20;
/** 20 页 CJK 文本按 UTF-8 最坏 3 字节/字符折算的结果预算; 超限由结果层外置兜底。 */
export const MAX_RESULT_BYTES = 150_000;
