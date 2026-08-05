// FileReadTool 的模型说明书与模型可见文案, 单点维护。
// description 是模型的唯一说明书: 这里没写的用法, 模型就不知道。
import {
  IMAGE_FILE_SIZE_LIMIT,
  MAX_READ_LINES,
  SELECTED_BYTES_LIMIT,
} from './limits.js';

/** 去重回放时给模型的引导语: 引用早前内容, 不要重读(Claude 同款)。 */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result '
  + 'in this conversation is still current — refer to that instead of re-reading.';

export const FILE_READ_DESCRIPTION = `Read a file from the local filesystem.

Usage:
- file_path must be an absolute path (or relative to the workspace root); this tool reads files only, not directories.
- Text is returned in cat -n format with 1-based line numbers.
- Use \`offset\` and \`limit\` to paginate large text files (limit up to ${MAX_READ_LINES} lines); omit both to read the entire file. Pagination streams the file — reading a slice of a huge file does not load it into memory.
- Each text read returns at most ${SELECTED_BYTES_LIMIT / 1024} KB of content; larger selections are truncated with a \`nextOffset\` to continue from. Files over 10 MiB can only be read with pagination.
- Image files (PNG/JPEG/GIF/WebP up to ${IMAGE_FILE_SIZE_LIMIT / 1024 / 1024} MiB) are returned as visual content you can see. \`offset\`/\`limit\` do not apply to images.
- PDF files are read with the PdfRead tool instead. Other binary files, device files, and UNC paths are refused.
- If the same file+range is read twice without the file changing, the tool reports it is unchanged — refer to the earlier content instead of re-reading.`;

/** 图片结果的模型文本说明; 图片本体走 image_data part, 不走这段文本。 */
export function imageResultNotice(filePath: string, mediaType: string, originalBytes: number): string {
  return `Read image ${filePath} (${mediaType}, ${(originalBytes / 1024).toFixed(1)} KB)`;
}
