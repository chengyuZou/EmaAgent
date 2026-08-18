// PdfReadTool 的模型说明书: 分页读取、续读语义与扫描页/图表不完整提示。
import { DEFAULT_PAGE_COUNT, MAX_PAGE_COUNT } from './limits.js';

export const PDF_READ_DESCRIPTION = `Read text and structure from a PDF file.

- Reads ${DEFAULT_PAGE_COUNT} pages by default and at most ${MAX_PAGE_COUNT} pages per call.
- Use start_page to continue from nextPage when a document is longer than one call.
- Text-layer pages are returned directly. Scanned pages and unparsed figures are reported as warnings instead of being silently omitted.
- This tool reads PDF only; use format-specific tools for DOCX, spreadsheets, or presentations.`;
