// 验证搜索适配层: 后端选择、共享过滤/归一/去重、Bing HTML 解析与错误映射, 不发起网络请求。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PublicHttpLimitError,
  PublicHttpStatusError,
  PublicHttpTimeoutError,
} from '@ema-agent/public-http';
import {
  extractBingResults,
  resolveBingUrl,
} from '../tools/WebSearchTool/adapters/bing.js';
import {
  filterAndNormalize,
  formatProviderError,
  normalizeDomains,
  resolveSearchProvider,
  RESULT_LIMIT,
} from '../tools/WebSearchTool/adapters/index.js';

const ENV_KEYS = ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'] as const;
const originalEnv = new Map<string, string | undefined>();

describe('resolveSearchProvider', () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('无凭据时回落到零配置的 Bing HTML scrape', () => {
    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['BRAVE_API_KEY'];
    expect(resolveSearchProvider()).toBe('bing');
  });

  it('BRAVE_SEARCH_API_KEY 存在时选择 Brave', () => {
    process.env['BRAVE_SEARCH_API_KEY'] = 'k';
    delete process.env['BRAVE_API_KEY'];
    expect(resolveSearchProvider()).toBe('brave');
  });

  it('BRAVE_API_KEY 别名同样生效(Claude 同款双环境变量)', () => {
    delete process.env['BRAVE_SEARCH_API_KEY'];
    process.env['BRAVE_API_KEY'] = 'k';
    expect(resolveSearchProvider()).toBe('brave');
  });

  it('空白 key 视为未配置', () => {
    process.env['BRAVE_SEARCH_API_KEY'] = '   ';
    delete process.env['BRAVE_API_KEY'];
    expect(resolveSearchProvider()).toBe('bing');
  });
});

describe('filterAndNormalize', () => {
  const raw = [
    { title: 'Exact', url: 'https://example.com/a', snippet: 's1' },
    { title: 'Sub', url: 'https://sub.example.com/b', snippet: '' },
    { title: 'Other', url: 'https://other.com/c', snippet: 's3' },
  ];

  it('allowed_domains 只保留精确或子域匹配', () => {
    const results = filterAndNormalize(raw, { allowedDomains: ['example.com'] });
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/a',
      'https://sub.example.com/b',
    ]);
  });

  it('blocked_domains 排除精确或子域匹配', () => {
    const results = filterAndNormalize(raw, { blockedDomains: ['example.com'] });
    expect(results.map((r) => r.url)).toEqual(['https://other.com/c']);
  });

  it('域名规整: trim/lowercase/去重', () => {
    expect(normalizeDomains([' Example.COM ', 'example.com', 'A.com']))
      .toEqual(['example.com', 'a.com']);
  });

  it('丢弃非法 URL 与重复 URL', () => {
    const results = filterAndNormalize([
      { title: 'ok', url: 'https://a.com/x', snippet: '' },
      { title: 'dup', url: 'https://a.com/x', snippet: '' },
      { title: 'js', url: 'javascript:alert(1)', snippet: '' },
      { title: 'ftp', url: 'ftp://a.com/f', snippet: '' },
      { title: 'bad', url: 'not a url', snippet: '' },
    ], {});
    expect(results.map((r) => r.url)).toEqual(['https://a.com/x']);
  });

  it('title/snippet 截断且结果数不超过 RESULT_LIMIT', () => {
    const longTitle = 't'.repeat(600);
    const longSnippet = 's'.repeat(400);
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: i === 0 ? longTitle : `t${i}`,
      url: `https://a.com/${i}`,
      snippet: i === 0 ? longSnippet : '',
    }));
    const results = filterAndNormalize(many, {});
    expect(results).toHaveLength(RESULT_LIMIT);
    expect(results[0]!.title).toHaveLength(500);
    expect(results[0]!.snippet).toHaveLength(300);
  });
});

describe('extractBingResults', () => {
  const bingHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?a=1&u=a1aHR0cHM6Ly9yZWFjdC5kZXYv" h="ID=SERP,1">React <b>Docs</b> &amp; More</a></h2>
    <div class="b_caption"><p class="b_lineclamp">The <b>official</b> React site &#8217;s docs</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="/search?q=internal">Internal</a></h2>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.com/page">Example &lt;Page&gt;</a></h2>
    <div class="b_caption"><p>Fallback paragraph snippet</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://direct.example.org/x">Direct</a></h2>
    <div class="b_caption">Plain caption text</div>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/search?q=internal2">Bing internal</a></h2>
  </li>
</ol>`;

  it('解析 b_algo 块: 跳转解码、实体解码、三段 snippet 提取', () => {
    const results = extractBingResults(bingHtml);
    expect(results).toEqual([
      {
        title: 'React Docs & More',
        url: 'https://react.dev/',
        snippet: 'The official React site \u2019s docs',
      },
      {
        title: 'Example <Page>',
        url: 'https://example.com/page',
        snippet: 'Fallback paragraph snippet',
      },
      {
        title: 'Direct',
        url: 'https://direct.example.org/x',
        snippet: 'Plain caption text',
      },
    ]);
  });

  it('空 HTML 返回空数组', () => {
    expect(extractBingResults('')).toEqual([]);
  });

  it('resolveBingUrl: u 参数 base64url 解码', () => {
    expect(
      resolveBingUrl('https://www.bing.com/ck/a?a=1&u=a1aHR0cHM6Ly9yZWFjdC5kZXYv'),
    ).toBe('https://react.dev/');
    expect(resolveBingUrl('https://example.com/direct')).toBe('https://example.com/direct');
  });

  it('resolveBingUrl: 相对链接、锚点与 Bing 站内链接丢弃', () => {
    expect(resolveBingUrl('/search?q=x')).toBeUndefined();
    expect(resolveBingUrl('#anchor')).toBeUndefined();
    expect(resolveBingUrl('https://www.bing.com/search?q=x')).toBeUndefined();
    expect(resolveBingUrl('https://www.bing.com/ck/a?a=1&u=garbage')).toBeUndefined();
  });
});

describe('formatProviderError', () => {
  it('Brave 401/403 提示检查 API key', () => {
    const error = formatProviderError(
      'brave',
      new PublicHttpStatusError(401, 'Unauthorized', 'https://api.search.brave.com/'),
    );
    expect(error.message).toContain('Brave 搜索失败(401)');
    expect(error.message).toContain('API key');
  });

  it('Bing 401 不提示 API key(无 key 后端)', () => {
    const error = formatProviderError(
      'bing',
      new PublicHttpStatusError(401, 'Unauthorized', 'https://www.bing.com/'),
    );
    expect(error.message).toBe('Bing 搜索失败(401)');
  });

  it('429 提示限流', () => {
    const error = formatProviderError(
      'bing',
      new PublicHttpStatusError(429, 'Too Many Requests', 'https://www.bing.com/'),
    );
    expect(error.message).toContain('Bing 搜索失败(429)');
    expect(error.message).toContain('限流');
  });

  it('超时给出明确提示', () => {
    expect(formatProviderError('bing', new PublicHttpTimeoutError(30_000)).message)
      .toContain('Bing 搜索超时');
  });

  it('体积/重定向限制透出原始原因', () => {
    expect(formatProviderError('bing', new PublicHttpLimitError('重定向次数超过 0 次')).message)
      .toBe('Bing 搜索失败: 重定向次数超过 0 次');
  });

  it('普通错误带上后端名', () => {
    expect(formatProviderError('bing', new Error('boom')).message)
      .toBe('Bing 搜索失败: boom');
  });
});
