// 在网络安全与响应大小边界内获取公开网页内容, 转换结果按 URL 缓存。
import { z } from 'zod';
import { findContentRule } from '@ema-agent/permission';
import { isObviouslyUnsafePublicUrl } from '@ema-agent/public-http';
import { buildTool, contextOk, type ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { fetchPublicPage } from './httpClient.js';
import { isPreapprovedHost } from './preapproved.js';
import { WEB_FETCH_DESCRIPTION } from './prompt.js';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_CHARS = 100_000;

// ── 输入 schema ──────────────────────────────────────────────────────────────

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
    .describe('Return raw HTML instead of converting to Markdown.'),
}).strict();

type WebFetchInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface WebFetchResult {
  /** 重定向后的最终 URL, 与首次请求的 finalUrl 一致。 */
  url: string;
  /** 响应体字节数, 供 UI 展示接收体积。 */
  bytes: number;
  code: number;
  codeText: string;
  /** 模型可见内容(分页后的 Markdown 或原始 HTML)。 */
  content: string;
  truncated: boolean;
  totalLength: number;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const WebFetchTool = buildTool<WebFetchInput, WebFetchResult, undefined>({
  id: BuiltinTools.WebFetch.id,
  name: BuiltinTools.WebFetch.name,
  description: WEB_FETCH_DESCRIPTION,
  // 业务上限是 100K 字符; 按 UTF-8 最坏 3 字节/字符(CJK)折算成结果预算。
  maxResultBytes: 300_000,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  getToolUseSummary: (input) => input.url,

  validateInput(input) {
    return isObviouslyUnsafePublicUrl(input.url)
      ? {
          valid: false,
          code: 'web_fetch/unsafe_url',
          message: 'URL 指向本机、私网或不受支持的协议，不能发送公网请求。',
          retryable: false,
        }
      : { valid: true };
  },

  // 域名内容规则(用户显式 deny/ask/allow 优先) → 预批准域名 → passthrough(中央收口)。
  async checkPermissions(input, _context, permissionContext) {
    const ruleContent = webFetchInputToPermissionRuleContent(input.url);
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
    const askRule = findContentRule(
      permissionContext, BuiltinTools.WebFetch.name, 'ask', ruleContent,
    );
    if (askRule) {
      return {
        behavior: 'ask',
        message: `访问 ${ruleContent} 需要用户确认`,
        decisionReason: { type: 'rule', rule: askRule },
      };
    }
    const allowRule = findContentRule(
      permissionContext, BuiltinTools.WebFetch.name, 'allow', ruleContent,
    );
    if (allowRule) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'rule', rule: allowRule },
      };
    }
    // 预批准域名只对 WebFetch 的 GET 放行, 不继承到其他工具或沙箱网络规则。
    if (isPreapprovedUrl(input.url)) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'other', reason: 'Preapproved host' },
      };
    }
    return { behavior: 'passthrough', message: '获取网页需要用户确认' };
  },

  // 本工具不消费宿主能力: 网络边界由 public-http 提供, 无需窄 Context。
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

  // 模型只需要内容本身; 字节/状态码等 HTTP 事实留在 TOutput 给 UI 与审计。
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

/** input → 内容规则语义串: domain:hostname。 */
function webFetchInputToPermissionRuleContent(url: string): string {
  try {
    return `domain:${new URL(url).hostname}`;
  } catch {
    return `input:${url}`;
  }
}
