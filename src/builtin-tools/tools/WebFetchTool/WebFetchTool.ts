import { z } from 'zod';
import { findContentRule, findMatchingContentRule } from '@ema-agent/permission';
import { buildTool, contextOk, type ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { fetchPublicPage } from './httpClient.js';
import { isPreapprovedHost } from './preapproved.js';
import { WEB_FETCH_DESCRIPTION } from './prompt.js';

const MAX_RESPONSE_CHARS = 100_000;

const inputSchema = z.object({
  url: z.url().describe('HTTP or HTTPS URL to fetch.'),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESPONSE_CHARS)
    .optional()
    .default(MAX_RESPONSE_CHARS)
    .describe('Maximum characters of response body to return.'),
  start_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Character offset to start reading from (for pagination).'),
  raw: z
    .boolean()
    .default(false)
    .describe('Return decoded source text without HTML extraction or Markdown conversion.'),
}).strict();

type WebFetchInput = z.infer<typeof inputSchema>;

export interface WebFetchResult {
  /** 重定向后的最终 URL, 分页读取仍使用同一个结果地址. */
  url: string;
  /** 原始响应体字节数, 供 UI 展示接收体积. */
  bytes: number;
  code: number;
  codeText: string;
  /** 分页后的正文 Markdown 或解码后的原始文本. */
  content: string;
  truncated: boolean;
  totalLength: number;
}

export const WebFetchTool = buildTool<WebFetchInput, WebFetchResult, undefined>({
  id: BuiltinTools.WebFetch.id,
  name: BuiltinTools.WebFetch.name,
  description: WEB_FETCH_DESCRIPTION,
  // 业务上限是 100K 个 UTF-16 字符单元, 按每单元至多 3 个 UTF-8 字节计算结果预算.
  maxResultBytes: 300_000,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  getToolUseSummary: (input) => input.url,

  validateInput(input) {
    // 只校验合法 HTTP/HTTPS 地址, 是否批准访问交给权限规则.
    try {
      const url = new URL(input.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('bad protocol');
      }
      return { valid: true };
    } catch {
      return {
        valid: false,
        code: 'web_fetch/invalid_url',
        message: 'URL 必须是合法的 http/https 地址.',
        retryable: false,
      };
    }
  },

  // 用户权限规则优先于预批准域名, 其余请求交给通用工具权限流程.
  async checkPermissions(input, _context, permissionContext) {
    const ruleContent = webFetchInputToPermissionRuleContent(input.url);
    const sessionAllowRule = { toolName: BuiltinTools.WebFetch.name, ruleContent };
    const denyRule = findContentRule(
      permissionContext, BuiltinTools.WebFetch.name, 'deny', ruleContent,
    );
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${BuiltinTools.WebFetch.name} 已禁止访问 ${ruleContent}`,
        decisionReason: { type: 'rule', rule: denyRule },
      };
    }
    const sessionRule = findMatchingContentRule(
      permissionContext, BuiltinTools.WebFetch.name, 'allow', content => content === ruleContent, 'session',
    );
    if (sessionRule) {
      return { behavior: 'allow', decisionReason: { type: 'rule', rule: sessionRule }, sessionAllowRule };
    }
    const askRule = findContentRule(
      permissionContext, BuiltinTools.WebFetch.name, 'ask', ruleContent,
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `访问 ${ruleContent} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
        sessionAllowRule,
      };
    }
    const allowRule = findContentRule(
      permissionContext, BuiltinTools.WebFetch.name, 'allow', ruleContent,
    );
    if (allowRule) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'rule', rule: allowRule },
        sessionAllowRule,
      };
    }
    // 预批准域名只对 WebFetch 的 GET 放行, 不继承到其他工具或沙箱网络规则.
    if (isPreapprovedUrl(input.url)) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'other', reason: 'Preapproved host' },
        sessionAllowRule,
      };
    }
    return { behavior: 'passthrough', message: '获取网页需要用户确认', sessionAllowRule };
  },

  validateContext() {
    return contextOk(undefined);
  },

  async execute(
    input: WebFetchInput,
    _context: undefined,
    invocation: ToolInvocation,
  ): Promise<WebFetchResult> {
    const { url, max_length, start_index, raw } = input;
    const page = await fetchPublicPage(url, invocation.signal, { raw });

    const totalLength = page.content.length;
    const truncated = start_index + max_length < totalLength;
    const content = truncated
      ? page.content.slice(start_index, start_index + max_length)
        + `\n[Output truncated: ${totalLength.toLocaleString()} chars -> ${max_length.toLocaleString()} chars shown. Use start_index to paginate.]`
      : page.content.slice(start_index, start_index + max_length);

    return {
      url: page.finalUrl,
      bytes: page.bytes,
      code: page.status,
      codeText: page.statusText,
      content,
      truncated,
      totalLength,
    };
  },

  // 模型只接收正文, HTTP 状态和体积由工具卡消费.
  mapResultToModelContent(output) {
    return output.content;
  },
});

function isPreapprovedUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isPreapprovedHost(url.hostname, url.pathname);
  } catch {
    return false;
  }
}

function webFetchInputToPermissionRuleContent(url: string): string {
  return `domain:${new URL(url).hostname}`;
}
