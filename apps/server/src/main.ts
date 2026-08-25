// server 进程唯一入口：共享密钥 → 生命周期 → 信号驱动的优雅关闭。
import { MissingSharedSecretError, requireSharedSecret } from './platform/auth.js';
import { startServer } from './platform/lifecycle.js';

async function main(): Promise<void> {
  const secret = requireSharedSecret();
  const lifecycle = await startServer(secret);
  console.log(`[server] 已监听 127.0.0.1:${lifecycle.port}`);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${signal}，即将关闭`);
    void lifecycle.shutdown()
      .catch(error => console.warn('[server] 关闭异常:', error))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(error => {
  if (error instanceof MissingSharedSecretError) {
    console.error('[server] 拒绝启动: EMA_SHARED_SECRET 未配置或长度不足（≥32）');
  } else {
    console.error('[server] 启动失败:', error);
  }
  process.exit(1);
});
