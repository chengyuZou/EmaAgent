import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { logging } from '@ema-agent/logging';
import { McpTimeoutError } from '../errors.js';
import type { McpOAuthClient } from './oauthClient.js';
import type { McpOAuthLoginResult, McpOAuthPendingLogin } from './types.js';

const DEFAULT_LOGIN_TIMEOUT_MS = 300_000; // 5 分钟超时

export interface StartOAuthLoginOptions {
  serverName: string;
  client: McpOAuthClient;
  timeoutMs?: number;
}

/**
 * 启动一次针对指定 MCP 服务的本地回环 OAuth 登录流程.
 *
 * 1. 在 127.0.0.1 申请空闲临时端口启动临时 HTTP 服务器.
 * 2. 组装 redirectUri, state 并挂载内存任务到 McpOAuthClient.
 * 3. 触发 SDK auth() 发现服务端元数据并生成 PKCE 授权跳转链接.
 * 4. 返回 authorizationUrl 供桌面端通过默认浏览器打开.
 * 5. 浏览器回调到达后校验 state, 调用 SDK 兑换并保存 Token, 回复浏览器友好提示页面后关闭临时端口.
 */
export async function startOAuthLogin(options: StartOAuthLoginOptions): Promise<McpOAuthLoginResult> {
  const { serverName, client, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS } = options;

  const state = randomUUID();
  const abortController = new AbortController();

  let server: Server | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let hasAcceptedCallback = false;

  let resolveSession!: () => void;
  let rejectSession!: (err: Error) => void;
  const sessionPromise = new Promise<void>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  // 调用方需等 startOAuthLogin 返回后才订阅 promise, 提前挂兜底避免提前取消时触发 Node 未处理拒绝.
  void sessionPromise.catch(() => undefined);

  const cleanup = async (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      // 纯同步解绑 Client 引用, 绝不反向调用 cancelPendingLogin(), 杜绝循环 await 死锁.
      client.detachPendingLogin(state);

      if (server) {
        const closingServer = server;
        server = undefined;
        await new Promise<void>((resolve) => {
          closingServer.close(() => resolve());
          // 取消或超时需要立刻切断仍挂起的回环请求连接, 防止 cancelPendingLogin 死锁等待远端换码.
          if (abortController.signal.aborted) {
            closingServer.closeAllConnections?.();
          } else {
            closingServer.closeIdleConnections?.();
          }
        });
      }
    })();
    return cleanupPromise;
  };

  try {
    // 启动临时回环服务器
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;

    const pendingLogin: McpOAuthPendingLogin = {
      state,
      redirectUri,
      startedAt: Date.now(),
      cleanup,
      promise: sessionPromise,
      abortController,
    };

    // 在挂载前注册超时与取消监听, 保证清理旧任务期间也能正确响应中止.
    timeoutTimer = setTimeout(() => {
      abortController.abort(new McpTimeoutError(serverName, 'oauth_login', timeoutMs));
    }, timeoutMs);

    abortController.signal.addEventListener(
      'abort',
      () => {
        const reason = abortController.signal.reason;
        client.detachPendingLogin(state);
        rejectSession(
          reason instanceof McpTimeoutError
            ? reason
            : new Error('OAuth login cancelled by user.'),
        );
        void cleanup();
      },
      { once: true },
    );

    await client.attachPendingLogin(pendingLogin);

    // 处理浏览器回调
    server.on('request', async (req, res) => {
      try {
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
          return;
        }

        const parsedUrl = new URL(req.url, redirectUri);
        if (parsedUrl.pathname !== '/oauth/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        // 先核对 state; 陌生/伪造请求的 state 不匹配仅返回 400, 不能中止当前正常登录会话.
        const receivedState = parsedUrl.searchParams.get('state');
        if (receivedState !== pendingLogin.state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderResultHtml(false, 'OAuth state 参数校验失败.'));
          return;
        }

        // 在任何 await 之前同步拦截刷新带来的重复回调或已失效登录会话.
        if (hasAcceptedCallback || abortController.signal.aborted || client.getPendingLogin() !== pendingLogin) {
          res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderResultHtml(false, '本次授权回调已处理或已取消, 请返回 EmaAgent.'));
          return;
        }

        const callbackError = parsedUrl.searchParams.get('error');
        const errorDesc = parsedUrl.searchParams.get('error_description');
        if (callbackError) {
          hasAcceptedCallback = true;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderResultHtml(false, `授权被拒绝: ${errorDesc ?? callbackError}`));
          client.detachPendingLogin(state);
          rejectSession(new Error(`OAuth authorization error: ${errorDesc ?? callbackError}`));
          res.on('finish', () => void cleanup());
          return;
        }

        const code = parsedUrl.searchParams.get('code');
        if (!code) {
          hasAcceptedCallback = true;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderResultHtml(false, '缺少授权码 (authorization code).'));
          client.detachPendingLogin(state);
          rejectSession(new Error('Missing OAuth authorization code in callback.'));
          res.on('finish', () => void cleanup());
          return;
        }

        hasAcceptedCallback = true;

        // 收到有效授权码, 在绑定本次登录会话与版本号的上下文中兑换 Token 并持久化.
        const authResult = await client.authorizeLogin(pendingLogin, code);
        if (abortController.signal.aborted || client.getPendingLogin() !== pendingLogin) {
          if (!res.headersSent && !res.destroyed && !res.writableEnded) {
            res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderResultHtml(false, '本次授权已取消或被新登录替换, 请返回 EmaAgent.'));
            res.on('finish', () => void cleanup());
          } else {
            void cleanup();
          }
          return;
        }

        if (authResult !== 'AUTHORIZED') {
          throw new Error(`Unexpected auth result from SDK: ${authResult}`);
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderResultHtml(true, '授权成功! 您现在可以关闭此页面返回 EmaAgent.'));
        client.detachPendingLogin(state);
        resolveSession();
        res.on('finish', () => void cleanup());
      } catch (err) {
        logging({
          level: 'error',
          target: 'mcp',
          event: 'mcp.oauth.callback_failed',
          message: `OAuth callback handling failed: ${(err as Error).message}`,
          error: err,
        });
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderResultHtml(false, `授权处理发生异常: ${(err as Error).message}`));
        }
        client.detachPendingLogin(state);
        rejectSession(err as Error);
        if (res.destroyed || res.writableEnded) {
          void cleanup();
        } else {
          res.on('finish', () => void cleanup());
        }
      }
    });

    // 触发初次 SDK auth() 流程以启动发现和跳转
    const initialResult = await client.authorizeLogin(pendingLogin);

    if (initialResult === 'AUTHORIZED') {
      // 若已有有效 Token 且无需重定向, 直接标记完成
      client.detachPendingLogin(state);
      resolveSession();
      void cleanup();
      return {
        authorizationUrl: null,
      };
    }

    if (!pendingLogin.authorizationUrl) {
      throw new Error('OAuth flow initiated but server did not provide authorization URL.');
    }

    return {
      authorizationUrl: pendingLogin.authorizationUrl.toString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    client.detachPendingLogin(state);
    rejectSession(error);
    await cleanup();
    throw err;
  }
}

function renderResultHtml(success: boolean, message: string): string {
  const title = success ? '授权成功 / Authorization Successful' : '授权未完成 / Authorization Incomplete';
  const color = success ? '#059669' : '#dc2626';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>EmaAgent - ${title}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 60px 20px; background-color: #f9fafb; color: #111827;">
  <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
    <h2 style="color: ${color}; margin-top: 0;">${title}</h2>
    <p style="font-size: 16px; line-height: 1.6; color: #4b5563;">${message}</p>
    <p style="font-size: 14px; color: #9ca3af; margin-top: 30px;">EmaAgent Local-first Desktop</p>
  </div>
</body>
</html>`;
}
