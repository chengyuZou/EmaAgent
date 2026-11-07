import { closeLogging, initializeLogging, logging, setDiagnosticSecrets } from '@ema-agent/logging';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { MissingSharedSecretError, takeSharedSecret } from './platform/auth.js';
import { stopServer } from './platform/shutdown.js';
import { profileDir } from './platform/paths.js';

async function main(): Promise<void> {
  const startedAt = performance.now();
  initializeLogging(path.join(profileDir(), 'logs'));
  logging({
    level: 'info',
    target: 'server',
    event: 'server.starting',
  });
  const secret = takeSharedSecret();
  setDiagnosticSecrets([secret]);
  // 部分工具在导入时探测系统命令. 先移除环境里的控制口令, 再加载会创建子进程的业务模块.
  const { startServer } = await import('./platform/lifecycle.js');
  const lifecycle = await startServer(secret);
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    void stopServer(lifecycle, signal).then(code => process.exit(code));
  };
  logging({
    level: 'info',
    target: 'server',
    event: 'server.ready',
    body: { port: lifecycle.port, durationMs: performance.now() - startedAt },
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async error => {
  if (error instanceof MissingSharedSecretError) {
    logging({
      level: 'error',
      target: 'server',
      event: 'server.auth.missing_secret',
    });
  } else {
    logging({
      level: 'error',
      target: 'server',
      event: 'server.startup.failed',
      error,
    });
  }
  await closeLogging();
  process.exit(1);
});
