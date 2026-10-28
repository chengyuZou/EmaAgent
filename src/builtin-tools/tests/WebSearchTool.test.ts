// 验证 WebSearchTool 的 schema、输入校验与模型投影, 不发起任何网络请求。
import { afterEach, describe, expect, it } from 'vitest';
import { checkToolPermission, rememberSessionApproval, clearSessionApprovals, type PermissionContext } from '@ema-agent/permission';
import {
  WebSearchTool,
  type WebSearchResult,
} from '../tools/WebSearchTool/WebSearchTool.js';

afterEach(() => clearSessionApprovals('permission-test'));

const checkSearchPermission = (input: unknown, toolContext: undefined, context: PermissionContext) =>
  checkToolPermission(WebSearchTool, WebSearchTool.inputSchema.parse(input), toolContext, context, { interactive: true });

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

describe('WebSearchTool 会话批准范围', () => {
  function context(): PermissionContext {
    return {
      mode: 'default', workspaceRoots: [],
      sessionId: 'permission-test', rules: [],
    };
  }

  it('整理搜索词首尾空格和域名列表, 不扩大到其他查询或过滤条件', async () => {
    let permissions = context();
    const first = await checkSearchPermission({
      query: '  Node.js stream  ',
      allowed_domains: ['NODEJS.ORG', 'github.com', 'nodejs.org'],
    }, undefined, permissions);
    expect(first.decision).toBe('ask');
    if (first.decision !== 'ask' || !first.sessionApproval) throw new Error('expected rule');
    expect(first.sessionApproval.key.condition).toBe(
      'search:{"query":"Node.js stream","allowed_domains":["github.com","nodejs.org"],"blocked_domains":[]}',
    );
    rememberSessionApproval(permissions.sessionId, first.sessionApproval.key);
    permissions = { ...permissions, rules: [{ key: first.sessionApproval.key, decision: 'ask', from: 'userSettings' }] };
    expect((await checkSearchPermission({
      query: 'Node.js stream', allowed_domains: ['nodejs.org', 'github.com'],
    }, undefined, permissions)).decision).toBe('allow');
    for (const input of [
      { query: 'Node.js errors', allowed_domains: ['nodejs.org', 'github.com'] },
      { query: 'Node.js stream', allowed_domains: ['nodejs.org'] },
      { query: 'Node.js stream' },
      { query: 'Node.js stream', blocked_domains: ['nodejs.org'] },
    ]) {
      expect((await checkSearchPermission(input, undefined, permissions)).decision).toBe('ask');
    }
    permissions = { ...permissions, rules: [{ key: first.sessionApproval.key, decision: 'deny', from: 'userSettings' }] };
    expect((await checkSearchPermission({
      query: 'Node.js stream', allowed_domains: ['nodejs.org', 'github.com'],
    }, undefined, permissions)).decision).toBe('deny');
  });

  it('缺省域名列表与显式空列表相同, 排除域名变化不是同一次搜索', async () => {
    let permissions = context();
    const first = await checkSearchPermission({ query: 'x' }, undefined, permissions);
    if (first.decision !== 'ask' || !first.sessionApproval) throw new Error('expected rule');
    rememberSessionApproval(permissions.sessionId, first.sessionApproval.key);
    expect((await checkSearchPermission({
      query: 'x', allowed_domains: [], blocked_domains: [],
    }, undefined, permissions)).decision).toBe('allow');
    expect((await checkSearchPermission({
      query: 'x', blocked_domains: ['example.test'],
    }, undefined, permissions)).decision).toBe('ask');
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

  it('非空结果输出 Links 列表, 提醒只引用实际支持回答的来源', () => {
    const output: WebSearchResult = {
      query: 'react',
      results: [{ title: 'React', url: 'https://react.dev/', snippet: 'Docs' }],
    };
    const content = String(WebSearchTool.mapResultToModelContent!(output));
    expect(content).toContain('Links:');
    expect(content).toContain('[React](https://react.dev/): Docs');
    expect(content).toContain('REMINDER: Cite only sources that actually support your answer');
  });

  it('getToolUseSummary 返回 query', () => {
    expect(WebSearchTool.getToolUseSummary?.({ query: 'react docs' }))
      .toBe('react docs');
  });
});
