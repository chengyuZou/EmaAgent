// 定义公网 HTTP 安全出口的请求、响应和已审批目标。
import type { IncomingHttpHeaders } from 'node:http';

export interface ApprovedPublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface PublicHttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
  maxRedirects?: number;
  headers?: Readonly<Record<string, string>>;
  /**
   * 按调用追加允许的请求头名(如 API key 头), 仅本次请求生效。
   * 只能用于调用方自己写死主机且 maxRedirects=0 的场景(如搜索 API)。
   * 路由、连接和消息边界头即使声明也不会放行。
   */
  additionalAllowedHeaders?: readonly string[];
}

export interface PublicHttpResponse {
  finalUrl: string;
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
