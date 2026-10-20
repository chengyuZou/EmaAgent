import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@ema-agent/permission';
import {
  WebFetchTool,
  type WebFetchResult,
} from '../tools/WebFetchTool/WebFetchTool.js';
import { WebPageCache, clearWebFetchCache } from '../tools/WebFetchTool/cache.js';
import { htmlToMarkdown } from '../tools/WebFetchTool/htmlToMarkdown.js';
import { isPreapprovedHost } from '../tools/WebFetchTool/preapproved.js';
import { createWebRequests } from '../webRequests.js';

const webRequests = createWebRequests({});
const request = webRequests.request;
afterAll(() => webRequests.close());

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

function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    workspaceRoots: [],
  };
}

describe('WebFetchTool 权限判定', () => {
  it('预批准域名放行', async () => {
    const decision = await WebFetchTool.checkPermissions(
      { url: 'https://docs.python.org/3/reference/' },
      request,
      makePermissionContext(),
    );
    expect(decision.behavior).toBe('allow');
  });

  it('其他域名交给中央(默认询问)', async () => {
    const decision = await WebFetchTool.checkPermissions(
      { url: 'https://example.com/page' },
      request,
      makePermissionContext(),
    );
    expect(decision.behavior).toBe('passthrough');
  });

  it('会话域名批准覆盖路径、协议和端口变化, 不覆盖其他域或子域', async () => {
    const context = makePermissionContext();
    context.alwaysAllowRules.session = ['WebFetch(domain:example.test)'];
    context.alwaysAskRules.userSettings = ['WebFetch(domain:example.test)'];
    for (const url of ['https://example.test/a', 'http://example.test:8443/b?q=1']) {
      const result = await WebFetchTool.checkPermissions(
        WebFetchTool.inputSchema.parse({ url }), request, context,
      );
      expect(result.behavior).toBe('allow');
    }
    for (const url of ['https://other.test/a', 'https://sub.example.test/a']) {
      const result = await WebFetchTool.checkPermissions(
        WebFetchTool.inputSchema.parse({ url }), request, context,
      );
      expect(result.behavior).toBe('passthrough');
    }
    context.alwaysDenyRules.userSettings = ['WebFetch(domain:example.test)'];
    expect((await WebFetchTool.checkPermissions(
      WebFetchTool.inputSchema.parse({ url: 'https://example.test/a' }), request, context,
    )).behavior).toBe('deny');
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
      await expect(WebFetchTool.execute(input, request, invocation))
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
      request,
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
      request,
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
      WebFetchTool.inputSchema.parse({ url }), request, invocation,
    );
    const raw = await WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url, raw: true }), request, invocation,
    );

    expect(markdown.content).toBe('# Hello');
    expect(raw.content).toBe(html);
    expect(WebPageCache.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
