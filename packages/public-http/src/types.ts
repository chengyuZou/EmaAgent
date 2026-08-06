// 定义公网 HTTP 安全出口的请求、响应和下载契约。
export interface ApprovedPublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type PublicHttpHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface PublicHttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
  maxRedirects?: number;
  headers?: Readonly<Record<string, string>>;
  /**
   * 只为调用方写死的主机放行额外请求头；携带这些头时禁止重定向。
   * Host、Range 与连接控制头不会因声明而放行。
   */
  additionalAllowedHeaders?: readonly string[];
}

export interface PublicHttpResponse {
  finalUrl: string;
  status: number;
  statusText: string;
  headers: PublicHttpHeaders;
  body: Buffer;
}
