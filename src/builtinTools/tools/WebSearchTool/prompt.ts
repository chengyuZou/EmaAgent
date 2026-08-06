// WebSearch 的模型说明书: 用途、强制引用、域名过滤语义与当前年月提醒。
// 描述在模块加载时计算一次, 进程内稳定, 不把后端选择或环境变量泄露给模型。
export const WEB_SEARCH_DESCRIPTION = buildWebSearchDescription();

function buildWebSearchDescription(): string {
  const currentMonthYear = new Date().toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  return `
Search the web and return relevant results (title, URL, snippet) for the query.

Use WebSearch for:
- Current events, recent data, and information beyond your knowledge cutoff
- Facts that change over time (prices, versions, releases, documentation)
- Verifying or updating knowledge you are not sure is still accurate

After answering based on search results, you MUST include a "Sources:" section at the end of your response with markdown hyperlinks: [Title](URL). Never skip the sources section.

Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
- allowed_domains restricts results to the given domains (exact or any subdomain); blocked_domains excludes them. Do not pass both at once.
- Keep the query focused and specific.
- The current month is ${currentMonthYear}. Use the current year when searching for recent information, documentation, or current events.
`;
}
