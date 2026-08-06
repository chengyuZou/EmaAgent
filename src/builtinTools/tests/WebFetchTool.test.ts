// 验证 WebFetchTool 的 schema、输入校验、权限意图、模型投影与缓存/转换细节, 不发起网络请求。
import { describe, expect, it } from 'vitest';
import {
  WebFetchTool,
  type WebFetchResult,
} from '../tools/WebFetchTool/WebFetchTool.js';
import { WebPageCache, clearWebFetchCache } from '../tools/WebFetchTool/cache.js';
import { htmlToMarkdown } from '../tools/WebFetchTool/htmlToMarkdown.js';
import { isPreapprovedHost } from '../tools/WebFetchTool/preapproved.js';

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
    'http://localhost/admin',
    'http://127.0.0.1/x',
    'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ])('拒绝不安全 URL: %s', (url) => {
    const result = WebFetchTool.validateInput!({ url });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('web_fetch/unsafe_url');
  });

  it('接受公开 URL', () => {
    const result = WebFetchTool.validateInput!({ url: 'https://docs.python.org/3/' });
    expect(result.valid).toBe(true);
  });
});

describe('WebFetchTool 权限意图', () => {
  it('预批准域名免询问', async () => {
    const intent = await WebFetchTool.getPermissionIntent!({
      url: 'https://docs.python.org/3/reference/',
    });
    expect(intent.promptPolicy).toBe('neverForTrustedBuiltin');
  });

  it('其他域名保持 whenRequired', async () => {
    const intent = await WebFetchTool.getPermissionIntent!({
      url: 'https://example.com/page',
    });
    expect(intent.promptPolicy).toBe('whenRequired');
  });

  it('无法解析的 URL 回退 whenRequired, 不抛错', async () => {
    const intent = await WebFetchTool.getPermissionIntent!({ url: 'not-a-url' });
    expect(intent.promptPolicy).toBe('whenRequired');
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
