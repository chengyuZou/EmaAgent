import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { buildComposition, type Composition } from '../composition/index.js';
import {
  runFileMaintenance,
  runRequiredRecovery,
  type StartupRecoveryDeps,
} from '../composition/recovery.js';
import { createRoutes } from '../routes/index.js';
import { acquireLock } from './lockfile.js';
import { dataDirPath, ensureDataDirLayout } from './paths.js';
import { HTTP_SERVER_TIMEOUTS } from './requestBudget.js';

export interface ServerLifecycle {
  /** 实际监听端口(宿主经 stdout 控制消息读取). */
  readonly port: number;
  shutdown(): Promise<void>;
}

/**
 * 必须先恢复异常退出时的运行记录, 再公布 ready, 避免界面等待已经不存在的执行.
 * 文件维护和 Memory 调度在公布端口后开始, 不重新执行中断的 Turn 或后台命令.
 */
export async function startServer(secret: string): Promise<ServerLifecycle> {
  let phaseStartedAt = performance.now();
  console.info('[server:startup] data directory preparation started');
  const activeDataDir = dataDirPath();
  ensureDataDirLayout(activeDataDir);
  logStartupDuration('data directory preparation', phaseStartedAt);

  phaseStartedAt = performance.now();
  console.info('[server:startup] data directory lock started');
  const lock = acquireLock(activeDataDir);
  if (!lock.acquired) {
    throw new Error(
      `数据目录已被另一个 server 进程占用: ${activeDataDir}(持有者 pid=${lock.conflict.pid})`,
    );
  }
  logStartupDuration('data directory lock', phaseStartedAt);

  let composition: Composition | undefined;
  let server: Server | undefined;
  let webSocketServer: WebSocketServer | undefined;
  try {
    phaseStartedAt = performance.now();
    console.info('[server:startup] composition started');
    const running = buildComposition({
      activeDataDir,
      initializeBuiltinCharacters: process.env['EMA_INITIALIZE_BUILTIN_CHARACTERS'] === '1',
    });
    composition = running;
    logStartupDuration('composition', phaseStartedAt);
    const recoveryDeps: StartupRecoveryDeps = {
      activeDataDir,
      dataDb: running.database.dataDb,
      session: running.database.session,
      turns: running.database.turns,
      subagents: running.database.subagents,
      subagentMessages: running.database.subagentMessages,
      toolExecutionState: running.tools.toolExecutionState,
      backgroundProcesses: running.tools.backgroundProcesses,
      settings: running.settings.settings,
      goals: running.database.goals,
    };
    phaseStartedAt = performance.now();
    console.info('[server:startup] required recovery started');
    runRequiredRecovery(recoveryDeps);
    logStartupDuration('required recovery', phaseStartedAt);

    phaseStartedAt = performance.now();
    console.info('[server:startup] route assembly and listening started');
    const app = createRoutes(running, secret);
    const channelWebSocketServer = new WebSocketServer({ noServer: true });
    webSocketServer = channelWebSocketServer;
    // 端口由 OS 分配(loopback ephemeral),实际端口经 stdout 控制消息报告宿主;
    // 没有任何需要用户或宿主配置的端口项.未传自定义 createServer 时 serve
    // 恒为 http1 Server(headersTimeout/requestTimeout 只在 http1 上存在).
    const httpServer = serve({
      fetch: app.fetch,
      port: 0,
      // 只监听本机; 业务请求仍需要共享密钥.
      hostname: '127.0.0.1',
      websocket: { server: channelWebSocketServer },
    }) as Server;
    server = httpServer;
    httpServer.headersTimeout = HTTP_SERVER_TIMEOUTS.headersMs;
    httpServer.requestTimeout = HTTP_SERVER_TIMEOUTS.requestBodyMs;
    await new Promise<void>(resolve => httpServer.once('listening', resolve));
    logStartupDuration('route assembly and listening', phaseStartedAt);
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    phaseStartedAt = performance.now();
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'server.ready', params: { port } })}\n`);
    logStartupDuration('ready publication', phaseStartedAt);

    runFileMaintenance(recoveryDeps);
    void running.tools.toolResultCleaner.sweep()
      .then(({ deleted, freedBytes }) => {
        if (deleted > 0) {
          console.warn(
            `[tools] 清理 ${deleted} 个外置 Tool Result, 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MiB`,
          );
        }
      })
      .catch(error => console.warn('[tools] 外置 Tool Result 清理跳过:', error));
    running.memory.start();
    return {
      port,
      async shutdown() {
        for (const socket of channelWebSocketServer.clients) socket.terminate();
        channelWebSocketServer.close();
        await new Promise<void>(resolve => {
          httpServer.close(() => resolve());
          // SSE 是长连接,close() 不会自然结束;本地桌面进程直接断开.
          httpServer.closeAllConnections();
        });
        await running.close();
        lock.release();
      },
    };
  } catch (error) {
    for (const socket of webSocketServer?.clients ?? []) socket.terminate();
    webSocketServer?.close();
    server?.close();
    await composition?.close();
    lock.release();
    throw error;
  }
}

function logStartupDuration(phase: string, startedAt: number): void {
  console.info(
    `[server:startup] ${phase} completed duration_s=${((performance.now() - startedAt) / 1000).toFixed(3)}`,
  );
}
