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
}

export interface PublicHttpResponse {
  finalUrl: string;
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
