// 验证 WebSearchTool 的 schema、输入校验与模型投影, 不发起任何网络请求。
import { describe, expect, it } from 'vitest';
import {
  WebSearchTool,
  type WebSearchResult,
} from '../tools/WebSearchTool/WebSearchTool.js';

describe('WebSearchTool schema', () => {
  it('接受 query 与域名过滤字段', () => {
    const input = WebSearchTool.inputSchema.parse({
      query: 'react docs',
      allowed_domains: ['react.dev'],
    });
    expect(input.query).toBe('react docs');
    expect(input.allowed_domains).toEqual(['react.dev']);
  });

  it('strict: 拒绝已删除的 num_results 等未知字段', () => {
    const result = WebSearchTool.inputSchema.safeParse({
      query: 'x',
      num_results: 5,
    });
    expect(result.success).toBe(false);
  });
});

describe('WebSearchTool validateInput', () => {
  it('拒绝空白 query', async () => {
    const result = await WebSearchTool.validateInput!({ query: '   ' });
    expect(result.valid).toBe(false);
  });

  it('拒绝 allowed_domains 与 blocked_domains 同时使用', async () => {
    const result = await WebSearchTool.validateInput!({
      query: 'x',
      allowed_domains: ['a.com'],
      blocked_domains: ['b.com'],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('invalid_domain_filter');
  });

  it.each(['a.com/path', 'https://a.com', 'a*.com', 'a com'])(
    '拒绝非法域名 %s',
    async (domain) => {
      const result = await WebSearchTool.validateInput!({
        query: 'x',
        allowed_domains: [domain],
      });
      expect(result.valid).toBe(false);
    },
  );

  it('接受合法域名(大小写、子域)', async () => {
    const result = await WebSearchTool.validateInput!({
      query: 'x',
      allowed_domains: ['Example.COM', 'sub.example.org'],
    });
    expect(result.valid).toBe(true);
  });
});

describe('WebSearchTool 模型投影与摘要', () => {
  it('空结果给出明确提示且不要求引用', () => {
    const content = String(WebSearchTool.mapResultToModelContent!({
      query: 'q',
      results: [],
    }));
    expect(content).toContain('No search results found');
    expect(content).not.toContain('REMINDER');
  });

  it('非空结果输出 Links 列表与 Sources 提醒', () => {
    const output: WebSearchResult = {
      query: 'react',
      results: [{ title: 'React', url: 'https://react.dev/', snippet: 'Docs' }],
    };
    const content = String(WebSearchTool.mapResultToModelContent!(output));
    expect(content).toContain('Links:');
    expect(content).toContain('[React](https://react.dev/): Docs');
    expect(content).toContain('REMINDER: You MUST include the sources above');
  });

  it('getToolUseSummary 返回 query', () => {
    expect(WebSearchTool.getToolUseSummary?.({ query: 'react docs' }))
      .toBe('react docs');
  });
});
