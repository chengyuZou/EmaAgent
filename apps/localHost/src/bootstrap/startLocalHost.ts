// 按固定顺序启动 LocalHost 的一次性业务初始化，并统一委托常驻后台生命周期。

import path from 'node:path';
import type { KbManager } from '@ema-agent/knowledge';
import type { MarketSourceStore } from '@ema-agent/marketplace';
import { MCP_SEEDS } from '@ema-agent/mcp';
import type { ModelsDevCatalog } from '@ema-agent/provider';
import { SKILL_SEEDS, type SkillStore } from '@ema-agent/skills';
import { profileDir } from '../storage-locations/index.js';
import type { BackgroundWork } from '../background/backgroundWork.js';
import type { ProviderRuntimeFacade } from '../wiring/provider-runtime.js';

const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 10_000;

type StartupKnowledge = Pick<KbManager, 'ensureDefault'>;
type StartupMarketplace = Pick<MarketSourceStore, 'ensureSeeds'>;
type StartupSkills = Pick<SkillStore, 'scanAndReconcile'>;
type StartupModelCatalog = Pick<ModelsDevCatalog, 'refresh' | 'size'>;
type StartupProviderRuntime = Pick<ProviderRuntimeFacade, 'syncBridge'>;
type StartupBackgroundWork = Pick<BackgroundWork, 'start' | 'shutdown'>;

export class LocalHostLifecycle {
  private startup: Promise<void> | null = null;
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(
    private readonly knowledge: StartupKnowledge,
    private readonly marketplace: StartupMarketplace,
    private readonly skills: StartupSkills,
    private readonly modelCatalog: StartupModelCatalog,
    private readonly providerRuntime: StartupProviderRuntime,
    private readonly backgroundWork: StartupBackgroundWork,
  ) {}

  /** 必需恢复完成后即可 ready；其余能力在后台独立启动并可降级。 */
  start(): Promise<void> {
    this.startup ??= this.startOnce();
    return this.startup;
  }

  async shutdown(): Promise<void> {
    await this.startup;
    await Promise.all([
      this.backgroundWork.shutdown(),
      ...this.backgroundTasks,
    ]);
  }

  private async startOnce(): Promise<void> {
    // 执行终态恢复属于 ready 前置条件；失败会让 start() 直接拒绝。
    this.backgroundWork.start();

    const defaultKbPath = path.join(profileDir(), 'kb-default');
    await this.runDegraded('marketplace seed', async () => {
      this.marketplace.ensureSeeds([...MCP_SEEDS, ...SKILL_SEEDS]);
    });
    await this.runDegraded('default KB', () =>
      this.knowledge.ensureDefault(defaultKbPath));

    this.trackBackground('skill reconcile', async () => {
      await this.skills.scanAndReconcile();
    });
    this.trackBackground('model catalog refresh', () =>
      this.refreshModelCatalog());
    this.trackBackground('initial bridge sync', () =>
      this.providerRuntime.syncBridge());
  }

  private async refreshModelCatalog(): Promise<void> {
    const payload = await this.modelCatalog.refresh({
      signal: AbortSignal.timeout(MODEL_CATALOG_REFRESH_TIMEOUT_MS),
    });
    if (payload !== null && this.modelCatalog.size > 0) {
      console.info(
        `[catalog] models.dev loaded (${this.modelCatalog.size} models)`,
      );
      return;
    }
    throw new Error('models.dev 返回空目录');
  }

  private trackBackground(
    name: string,
    operation: () => void | Promise<void>,
  ): void {
    const task = this.runDegraded(name, operation);
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private async runDegraded(
    name: string,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.warn(`[startup] ${name} degraded:`, error);
    }
  }
}
