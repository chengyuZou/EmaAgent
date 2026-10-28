import { domainToASCII } from 'node:url';
import type { ToolPermissionCheck } from '../types.js';
import type { PreparedPermissionCheck } from './preparedPermissionCheck.js';
import { isPreapprovedHost } from './webPreapprovedHosts.js';

type WebPermissionCheck = Extract<ToolPermissionCheck, { kind: 'webFetch' | 'webSearch' }>;

export function prepareWebPermission(toolName: string, check: WebPermissionCheck): PreparedPermissionCheck {
  if (check.kind === 'webFetch') {
    const url = new URL(check.url);
    const condition = `domain:${url.hostname.toLowerCase()}`;
    return {
      defaultDecision: isPreapprovedHost(url.hostname, url.pathname) ? 'allow' : 'ask',
      confirmation: 'byRules',
      message: `允许访问 ${check.url} 吗?`,
      matchesConditions: conditions => conditions.includes(condition),
      sessionApproval: {
        key: { toolName, condition },
        description: `本会话允许 ${toolName} 访问 ${url.hostname} 的不同路径和端口, 不包含子域名.`,
      },
    };
  }

  const normalizeDomains = (domains: readonly string[] = []): string[] =>
    [...new Set(domains.map(domain => domainToASCII(domain.trim().toLowerCase())).filter(Boolean))].sort();
  const condition = `search:${JSON.stringify({
    query: check.query.trim(),
    allowed_domains: normalizeDomains(check.allowedDomains),
    blocked_domains: normalizeDomains(check.blockedDomains),
  })}`;
  return {
    defaultDecision: 'ask',
    confirmation: 'byRules',
    message: `允许搜索 "${check.query.trim()}" 吗?`,
    matchesConditions: conditions => conditions.includes(condition),
    sessionApproval: {
      key: { toolName, condition },
      description: '本会话允许相同搜索词及相同域名限制的搜索, 不批准后续网页访问.',
    },
  };
}
