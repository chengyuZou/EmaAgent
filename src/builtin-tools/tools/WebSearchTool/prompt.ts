/** 当前年月在模块加载时计算, 进程内保持稳定, 避免每轮改变工具说明. */
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

Cite the sources that actually support your answer using markdown hyperlinks: [Title](URL). Do not cite every returned result merely because it appears in the list. Search snippets are previews, not verified page content; use WebFetch to check details when needed.

Example format:

    [Your answer here]

    Sources used:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
- allowed_domains restricts results to the given domains (exact or any subdomain); blocked_domains excludes them. Do not pass both at once.
- Keep the query focused and specific.
- Results retain the search provider's order after domain filtering and URL deduplication. Search cannot verify that a page is correct.
- The current month is ${currentMonthYear}. Include dates or versions when they matter to the question. Do not replace an explicitly requested historical date or software version with the current year.
`;
}
