import { closeLogging, logging } from '@ema-agent/logging';
import type { ServerLifecycle } from './lifecycle.js';

/** 返回进程退出码, 调用方在业务收尾和日志文件关闭后才 process.exit. */
export async function stopServer(lifecycle: Pick<ServerLifecycle, 'shutdown'>, reason: string): Promise<number> {
  logging({
    level: 'info',
    target: 'server',
    event: 'server.stopping',
    body: { reason },
  });
  let exitCode = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lifecycle.shutdown(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Server shutdown exceeded 8 seconds.')), 8_000);
      }),
    ]);
    logging({
      level: 'info',
      target: 'server',
      event: 'server.stopped',
    });
  } catch (error) {
    exitCode = 1;
    logging({
      level: 'error',
      target: 'server',
      event: 'server.shutdown.failed',
      error,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const logsClosed = await closeLogging();
  return logsClosed ? exitCode : 1;
}
