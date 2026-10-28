import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolPermission, rememberSessionApproval, clearSessionApprovals, type PermissionContext } from '@ema-agent/permission';
import {
  WebFetchTool,
  type WebFetchResult,
} from '../tools/WebFetchTool/WebFetchTool.js';
import { WebPageCache, clearWebFetchCache } from '../tools/WebFetchTool/storage/cache.js';
import { htmlToMarkdown } from '../tools/WebFetchTool/content/htmlToMarkdown.js';
import { isPreapprovedHost } from '../../permission/checks/webPreapprovedHosts.js';
import { closeWebRequests } from '../tools/WebFetchTool/network/webRequests.js';

beforeEach(() => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'EMA_WEB_SYSTEM_PROXY']) {
    vi.stubEnv(name, '');
    vi.stubEnv(name.toLowerCase(), '');
  }
});

afterEach(async () => {
  clearSessionApprovals('permission-test');
  await closeWebRequests();
  vi.unstubAllEnvs();
});

describe('WebFetchTool schema', () => {
  it('接受 url 并给出分页/raw 默认值', () => {
    const input = WebFetchTool.inputSchema.parse({ url: 'https://example.com/docs' });
    expect(input.max_length).toBe(100_000);
    expect(input.start_index).toBe(0);
    expect(input.raw).toBe(false);
  });

  it('strict: 拒绝未知字段', () => {
    const result = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com',
      prompt: 'extract',
    });
    expect(result.success).toBe(false);
  });
});

describe('WebFetchTool validateInput', () => {
  it.each([
    'file:///etc/passwd',
    'not-a-url',
    'ftp://example.com/x',
  ])('拒绝非 http/https 或非法 URL: %s', (url) => {
    const result = WebFetchTool.validateInput!({ url });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('web_fetch/invalid_url');
  });

  it('接受公开 URL', () => {
    const result = WebFetchTool.validateInput!({ url: 'https://docs.python.org/3/' });
    expect(result.valid).toBe(true);
  });
});

function makePermissionContext(): PermissionContext {
  return {
    mode: 'default',
    sessionId: 'permission-test', rules: [],
    workspaceRoots: [],
  };
}

const checkFetchPermission = (input: unknown, toolContext: undefined, context: PermissionContext) =>
  checkToolPermission(WebFetchTool, WebFetchTool.inputSchema.parse(input), toolContext, context, { interactive: true });

describe('WebFetchTool 权限判定', () => {
  it('预批准域名放行', async () => {
    const decision = await checkFetchPermission(
      { url: 'https://docs.python.org/3/reference/' },
      undefined,
      makePermissionContext(),
    );
    expect(decision.decision).toBe('allow');
  });

  it('其他域名交给中央(默认询问)', async () => {
    const decision = await checkFetchPermission(
      { url: 'https://example.com/page' },
      undefined,
      makePermissionContext(),
    );
    expect(decision.decision).toBe('ask');
  });

  it('会话域名批准覆盖路径、协议和端口变化, 不覆盖其他域或子域', async () => {
    let context = makePermissionContext();
    rememberSessionApproval(context.sessionId, { toolName: 'WebFetch', condition: 'domain:example.test' });
    context = { ...context, rules: [{ key: { toolName: 'WebFetch', condition: 'domain:example.test' }, decision: 'ask', from: 'userSettings' }] };
    for (const url of ['https://example.test/a', 'http://example.test:8443/b?q=1']) {
      const result = await checkFetchPermission(
        WebFetchTool.inputSchema.parse({ url }), undefined, context,
      );
      expect(result.decision).toBe('allow');
    }
    for (const url of ['https://other.test/a', 'https://sub.example.test/a']) {
      const result = await checkFetchPermission(
        WebFetchTool.inputSchema.parse({ url }), undefined, context,
      );
      expect(result.decision).toBe('ask');
    }
    context = { ...context, rules: [{ key: { toolName: 'WebFetch', condition: 'domain:example.test' }, decision: 'deny', from: 'userSettings' }] };
    expect((await checkFetchPermission(
      WebFetchTool.inputSchema.parse({ url: 'https://example.test/a' }), undefined, context,
    )).decision).toBe('deny');
  });
});

describe('WebFetchTool 模型投影与摘要', () => {
  it('mapResultToModelContent 只返回内容本身', () => {
    const output: WebFetchResult = {
      url: 'https://example.com',
      bytes: 123,
      code: 200,
      codeText: 'OK',
      content: '# Hello',
      truncated: false,
      totalLength: 8,
    };
    expect(WebFetchTool.mapResultToModelContent!(output)).toBe('# Hello');
  });

  it('getToolUseSummary 返回 URL', () => {
    expect(WebFetchTool.getToolUseSummary?.({ url: 'https://example.com' }))
      .toBe('https://example.com');
  });
});

describe('WebFetchTool 读取网页', () => {
  const invocation = {
    sessionId: 'fetch-session',
    turnId: 'fetch-turn',
    toolCallId: 'fetch-call',
    signal: new AbortController().signal,
  };

  beforeEach(() => {
    clearWebFetchCache();
  });

  afterEach(() => {
    clearWebFetchCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { status: 403, statusText: 'Forbidden', raw: false },
    { status: 404, statusText: 'Not Found', raw: false },
    { status: 403, statusText: 'Forbidden', raw: true },
    { status: 404, statusText: 'Not Found', raw: true },
  ])('HTTP $status, raw=$raw 时错误摘要不作为正文缓存', async ({ status, statusText, raw }) => {
    const url = 'https://example.com/error';
    const fetchMock = vi.fn(() => {
      const response = new Response('<h1>Error page</h1>', {
        status,
        statusText,
        headers: { 'content-type': 'text/html' },
      });
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const input = WebFetchTool.inputSchema.parse({ url, raw });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(WebFetchTool.execute(input, undefined, invocation))
        .rejects.toMatchObject({
          code: `web/http_${status}`,
          message: expect.stringContaining('Error page'),
        });
    }

    expect(WebPageCache.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('成功读取保留最终网址, 后续分页复用完整转换结果', async () => {
    const response = new Response('<p>abcdefgh</p>', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
    });
    Object.defineProperty(response, 'url', { value: 'https://docs.example.com/final' });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const url = 'http://example.com/start';

    const first = await WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url, max_length: 3 }),
      undefined,
      invocation,
    );
    expect(first).toMatchObject({
      url: 'https://docs.example.com/final',
      code: 200,
      codeText: 'OK',
      totalLength: 8,
      truncated: true,
    });
    expect(first.content).toBe(
      'abc\n[Output truncated: 8 chars -> 3 chars shown. Use start_index to paginate.]',
    );

    const second = await WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url, start_index: 3, max_length: 5 }),
      undefined,
      invocation,
    );
    expect(second.content).toBe('defgh');
    expect(second.truncated).toBe(false);
    expect(second.url).toBe(first.url);
    expect(WebPageCache.get(`md:${url}`)?.content).toBe('abcdefgh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/start', expect.objectContaining({
      redirect: 'follow',
    }));
  });

  it('同一网址的原始 HTML 与 Markdown 分别缓存', async () => {
    const html = '<h1>Hello</h1>';
    const fetchMock = vi.fn(() => Promise.resolve(new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://example.com/page';

    const markdown = await WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url }), undefined, invocation,
    );
    const raw = await WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url, raw: true }), undefined, invocation,
    );

    expect(markdown.content).toBe('# Hello');
    expect(raw.content).toBe(html);
    expect(WebPageCache.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports missing static content without inventing text, while raw retains the server response', async () => {
    const html = '<html><head><title>App</title></head><body><div id="root"></div><script>renderApp()</script></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () => {
      const response = new Response(html, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://example.com/app' });
      return response;
    }));
    const input = WebFetchTool.inputSchema.parse({ url: 'https://example.com/app' });
    await expect(WebFetchTool.execute(input, undefined, invocation)).rejects.toThrow('没有读到静态正文');
    expect(WebPageCache.size).toBe(0);
    const raw = await WebFetchTool.execute({ ...input, raw: true }, undefined, invocation);
    expect(raw.content).toBe(html);
  });

  it('retains short static content, code, table cells and resolved links', async () => {
    const html = '<html><head><title>Reference</title></head><body><nav>Menu only</nav>'
      + '<main><p>Actual body.</p><pre>count &lt; 5</pre><table><tr><th>Field</th><th>Value</th></tr>'
      + '<tr><td>limit</td><td>42</td></tr></table><a href="../next">Next</a></main></body></html>';
    const response = new Response(html, { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://example.com/docs/start' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url: 'https://example.com/docs/start' }), undefined, invocation,
    );
    expect(result.content).toContain('Actual body.');
    expect(result.content).toContain('count < 5');
    expect(result.content).toContain('<td>limit</td><td>42</td>');
    expect(result.content).toContain('https://example.com/next');
    expect(result.content).not.toContain('Menu only');
  });
});

describe('htmlToMarkdown', () => {
  it('turndown 转换标题、粗体与链接', async () => {
    const markdown = await htmlToMarkdown(
      '<h1>Hi</h1><p>Hello <b>world</b> and <a href="https://x.dev">link</a></p>',
    );
    expect(markdown).toContain('# Hi');
    expect(markdown).toContain('**world**');
    expect(markdown).toContain('[link](https://x.dev)');
  });
});

describe('preapproved', () => {
  it('hostname 精确匹配, 不自动放行父域或近似域', () => {
    expect(isPreapprovedHost('docs.python.org', '/x')).toBe(true);
    expect(isPreapprovedHost('python.org', '/x')).toBe(false);
    expect(isPreapprovedHost('evil-docs.python.org', '/x')).toBe(false);
  });

  it('路径前缀按段边界匹配', () => {
    expect(isPreapprovedHost('vercel.com', '/docs')).toBe(true);
    expect(isPreapprovedHost('vercel.com', '/docs/guides')).toBe(true);
    expect(isPreapprovedHost('vercel.com', '/docs-evil')).toBe(false);
    expect(isPreapprovedHost('vercel.com', '/dashboard')).toBe(false);
  });
});

describe('WebPageCache', () => {
  it('写入、读取与清空', () => {
    WebPageCache.set(
      'md:https://example.com',
      {
        finalUrl: 'https://example.com/',
        bytes: 3,
        code: 200,
        codeText: 'OK',
        contentType: 'text/html',
        content: 'abc',
      },
      { size: 3 },
    );
    expect(WebPageCache.get('md:https://example.com')?.content).toBe('abc');
    clearWebFetchCache();
    expect(WebPageCache.get('md:https://example.com')).toBeUndefined();
  });
});
