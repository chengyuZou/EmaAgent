/**
 * MCP OAuth 授权状态.
 * - 'required': 尚未授权, 凭据已清除, 或服务返回 401 需重新授权.
 * - 'authorizing': 本地回环端口已拉起, 正在等待浏览器端完成回调.
 * - 'authorized': 当前持有有效的 Access Token.
 */
export type McpOAuthState = 'required' | 'authorizing' | 'authorized';

/**
 * 呈现在前端界面的 OAuth 状态摘要.
 */
export interface McpOAuthStatus {
  readonly status: McpOAuthState;
  /** Access Token 过期毫秒时间戳, 未知或无过期时为 null. */
  readonly expiresAtMs: number | null;
  /** 上次凭据更新毫秒时间戳. */
  readonly updatedAt: number;
}

/**
 * 浏览器授权进行中的内存任务对象.
 * 包含临时回调端口信息, PKCE Code Verifier, 以及用于用户取消与超时的控制通道.
 */
export interface McpOAuthPendingLogin {
  readonly serverId: string;
  readonly serverName: string;
  readonly serverUrl: string;
  /** OAuth 2.0 state 防跨站伪造随机字符串. */
  readonly state: string;
  /** 本次临时 HTTP 回调地址, 如 http://127.0.0.1:54321/oauth/callback. */
  readonly redirectUri: string;
  /** PKCE 验证码, 由 SDK startAuthorization 生成并暂存. */
  codeVerifier?: string;
  /** 服务端返回的授权重定向目标 URL. */
  authorizationUrl?: URL;
  /** 释放临时 HTTP 回调端口与清理定时器. */
  readonly cleanup: () => Promise<void>;
  /** 任务完成或失败的异步 Promise. */
  readonly promise: Promise<void>;
  /** 外部中止信号控制器. */
  readonly abortController: AbortController;
}

/**
 * 启动 OAuth 登录返回给前端的结果.
 */
export interface McpOAuthLoginResult {
  readonly authorizationUrl: string;
}
