// 进程生命周期：数据目录决议 → 锁 → Composition → 启动恢复 → 监听 → ready 文件 → 后台驱动；
// 以及对应的优雅关闭。只编排顺序，不实现业务，业务对象全部来自 Composition。
import path from 'node:path';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { narrativeBridgeEnabledSetting } from '@ema-agent/narrative';
import { buildComposition, type Composition } from '../composition/index.js';
import {
  runFileMaintenance,
  runRequiredRecovery,
  type StartupRecoveryDeps,
} from '../composition/recovery.js';
import { createRoutes } from '../routes/index.js';
import { activeDirEntry, loadRegistry } from './dataDirRegistry.js';
import { acquireLock } from './lockfile.js';
import { ensureDataDirLayout } from './paths.js';
import { publishReadyFile } from './readiness.js';
import { HTTP_SERVER_TIMEOUTS } from './requestBudget.js';

const TURN_EVENT_SWEEP_MS = 60_000;

export interface ServerLifecycle {
  readonly composition: Composition;
  /** 实际监听端口（宿主经 ready 文件读取）。 */
  readonly port: number;
  shutdown(): Promise<void>;
}

/**
 * 唯一启动序列。失败即抛：入口负责打印并非零退出。
 * 启动恢复是 ready 前置（不能把旧 running 状态留给新进程）；ready 之后的后台驱动
 * （文件维护、Narrative 推送、默认 KB、后台进程续跑、事件店逐出）全部可降级。
 */
export async function startServer(secret: string): Promise<ServerLifecycle> {
  const activeDataDir = activeDirEntry(loadRegistry()).path;
  ensureDataDirLayout(activeDataDir);

  const lock = acquireLock(activeDataDir);
  if (!lock.acquired) {
    throw new Error(
      `数据目录已被另一个 server 进程占用: ${activeDataDir}（持有者 pid=${lock.conflict.pid}）`,
    );
  }

  let composition: Composition | undefined;
  let server: Server | undefined;
  try {
    const running = buildComposition({ activeDataDir });
    composition = running;
    const recoveryDeps: StartupRecoveryDeps = {
      activeDataDir,
      dataDb: running.database.dataDb,
      session: running.database.session,
      turns: running.database.turns,
      agentRuns: running.database.agentRuns,
      toolExecutionState: running.tools.toolExecutionState,
      backgroundProcesses: running.tools.backgroundProcesses,
      settings: running.settings.settings,
    };
    runRequiredRecovery(recoveryDeps);

    const app = createRoutes(running, secret);
    // 端口由 OS 分配（loopback ephemeral），实际端口经 ready 文件报告宿主；
    // 没有任何需要用户或宿主配置的端口项。未传自定义 createServer 时 serve
    // 恒为 http1 Server（headersTimeout/requestTimeout 只在 http1 上存在）。
    const httpServer = serve({
      fetch: app.fetch,
      port: 0,
      // loopback 是全部信任边界；绝不绑外部接口。
      hostname: '127.0.0.1',
    }) as Server;
    server = httpServer;
    httpServer.headersTimeout = HTTP_SERVER_TIMEOUTS.headersMs;
    httpServer.requestTimeout = HTTP_SERVER_TIMEOUTS.requestBodyMs;
    await new Promise<void>(resolve => httpServer.once('listening', resolve));
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const unpublishReady = publishReadyFile(port);

    // ── ready 之后的后台驱动 ──────────────────────────────────────────────
    runFileMaintenance(recoveryDeps);
    // Bridge 进程开关：关闭时不再推送配置，且把宿主已拉起的 Bridge 令退；
    // 运行中改为关闭立即生效，重新开启需重启应用（宿主不会重新拉起 Bridge）。
    if (running.settings.settings.get(narrativeBridgeEnabledSetting)) {
      void running.narrative.configureNarrativeBridge()
        .catch(error => console.warn('[narrative] Bridge 配置推送失败:', error));
    } else {
      void running.narrative.shutdownNarrativeBridge()
        .catch(error => console.warn('[narrative] Bridge 关闭失败:', error));
    }
    const unsubscribeBridgeSwitch = running.settings.settings.subscribe(event => {
      if (!event.changedKeys.includes(narrativeBridgeEnabledSetting.key)) return;
      if (running.settings.settings.get(narrativeBridgeEnabledSetting)) return;
      void running.narrative.shutdownNarrativeBridge()
        .catch(error => console.warn('[narrative] Bridge 关闭失败:', error));
    });
    void running.knowledge.kb.ensureDefault(path.join(activeDataDir, 'kb', 'default'))
      .catch(error => console.warn('[kb] 默认知识库创建失败:', error));
    running.backgroundCompletion.start();
    const sweepTick = setInterval(
      () => running.turnEvents.evictExpired(),
      TURN_EVENT_SWEEP_MS,
    );
    sweepTick.unref();

    return {
      composition: running,
      port,
      async shutdown() {
        clearInterval(sweepTick);
        unsubscribeBridgeSwitch();
        unpublishReady?.();
        await new Promise<void>(resolve => {
          httpServer.close(() => resolve());
          // SSE 是长连接，close() 不会自然结束；本地桌面进程直接断开。
          httpServer.closeAllConnections();
        });
        running.close();
        lock.release();
      },
    };
  } catch (error) {
    server?.close();
    composition?.close();
    lock.release();
    throw error;
  }
}
