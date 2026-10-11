// 文案保持静态, 不随运行时能力变化, 避免重复生成工具说明影响模型侧 Prompt Cache.
export const WEB_FETCH_DESCRIPTION = `Fetch content from a specified URL and return it as Markdown (or raw HTML if raw: true).

Use WebFetch when you need to read a known page: documentation, source code, articles, or any URL the user or a search result points to. This tool is read-only.

IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check whether the URL requires a login (for example Google Docs, Confluence, Jira, or private repositories). If so, ask the user how to access the content instead.

Usage notes:
- HTTP URLs are automatically upgraded to HTTPS.
- HTTP redirects are followed automatically. The result URL is the final destination.
- Unsuccessful HTTP responses are reported as errors, not returned as page content.
- Pages are converted to Markdown before returning. Use raw: true only for troubleshooting.
- Large pages are paginated with start_index + max_length. When output is truncated, continue with a new call using start_index.
- Repeated fetches of the same URL are served from a self-cleaning 15-minute cache.
- The tool never modifies files or sends any credentials.`;
