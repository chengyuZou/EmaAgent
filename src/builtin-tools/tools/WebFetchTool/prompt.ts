// 文案保持静态, 不随运行时能力变化, 避免重复生成工具说明影响模型侧 Prompt Cache.
export const WEB_FETCH_DESCRIPTION = `Fetch content from a specified URL. HTML pages return their main content as Markdown; other supported text formats retain their original text. raw: true returns decoded source text without extraction or conversion.

Use WebFetch when you need to read a known page: documentation, source code, articles, or any URL the user or a search result points to. This tool is read-only.

IMPORTANT: WebFetch does not use browser login sessions or execute JavaScript. A page that requires login or client-side rendering may be unreadable or show only a login page. Ask the user for accessible content or suggest opening it in the browser; do not treat a missing static body as proof the page is empty.

Usage notes:
- HTTP URLs are automatically upgraded to HTTPS.
- HTTP redirects are followed automatically. The result URL is the final destination.
- Unsuccessful HTTP responses are reported as errors, not returned as page content.
- Article extraction removes navigation and other surrounding content. Documentation retains code blocks and tables; tables may remain as HTML. Extraction is not a question-answering step: read the returned content and check whether it supports the claim.
- Relative links and image URLs in extracted HTML are resolved using the final destination and the document's base URL. Use raw: true only for troubleshooting; source text is not rewritten.
- Plain text, Markdown, JSON, XML, and source files are not treated as HTML.
- Large pages are paginated with start_index + max_length. When output is truncated, continue with a new call using start_index.
- Repeated fetches of the same URL are served from a self-cleaning 15-minute cache.
- The tool never modifies files or sends any credentials.`;
