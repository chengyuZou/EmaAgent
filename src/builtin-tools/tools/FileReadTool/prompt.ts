// FileReadTool 的模型说明书与模型可见文案, 单点维护。
// description 是模型的唯一说明书: 这里没写的用法, 模型就不知道。
import {
  IMAGE_FILE_SIZE_LIMIT,
  MAX_READ_LINES,
  MAX_PDF_BYTES,
  DEFAULT_PDF_PAGE_COUNT,
  MAX_PDF_PAGE_COUNT,
  SELECTED_BYTES_LIMIT,
} from './limits.js';

export const FILE_READ_DESCRIPTION = `Read a file from the local filesystem.

Usage:
- file_path must be an absolute path (or relative to the workspace root); this tool reads files only, not directories.
- Text is returned in cat -n format with 1-based line numbers.
- Use \`offset\` and \`limit\` to paginate large text files (limit up to ${MAX_READ_LINES} lines); omit both to read the entire file. Pagination streams the file — reading a slice of a huge file does not load it into memory.
- Each text read returns at most ${SELECTED_BYTES_LIMIT / 1024} KB of content; larger selections are truncated with a \`nextOffset\` to continue from. Files over 10 MiB can only be read with pagination.
- Image files (PNG/JPEG/GIF/WebP up to ${IMAGE_FILE_SIZE_LIMIT / 1024 / 1024} MiB) are returned as visual content you can see. \`offset\`/\`limit\` do not apply to images.
- Notebook files (.ipynb) are parsed into cells with their outputs; oversized outputs are summarized. \`offset\`/\`limit\` do not apply to notebooks.
- PDF files are parsed by this tool (up to ${MAX_PDF_BYTES / 1024 / 1024} MiB). Use start_page and page_count (1-based pages, defaults to ${DEFAULT_PDF_PAGE_COUNT}, maximum ${MAX_PDF_PAGE_COUNT}); offset/limit are text-line parameters and must not be used for PDF.
- PDF results include totalPages and nextPage for continuation. Scanned or garbled pages use the configured Vision model for OCR; figures use it for captions. Without Vision, these pages/figures produce explicit warnings rather than complete content.
- Other binary files, device files, and UNC paths are refused.
- Repeated reads of an unchanged file return the requested content from the session cache.`;

/** 图片结果的模型文本说明; 图片本体走 image_data part, 不走这段文本。 */
export function imageResultNotice(filePath: string, mediaType: string, originalBytes: number): string {
  return `Read image ${filePath} (${mediaType}, ${(originalBytes / 1024).toFixed(1)} KB)`;
}
