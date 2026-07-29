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

type StartupKnowledge = Pick<KbManager, 'ensureDefault' | 'initAll'>;
type StartupMarketplace = Pick<MarketSourceStore, 'ensureSeeds'>;
type StartupSkills = Pick<SkillStore, 'scanAndReconcile'>;
type StartupModelCatalog = Pick<ModelsDevCatalog, 'refresh' | 'size'>;
type StartupProviderRuntime = Pick<ProviderRuntimeFacade, 'syncBridge'>;
type StartupBackgroundWork = Pick<BackgroundWork, 'start' | 'shutdown'>;

export class LocalHostLifecycle {
  private startup: Promise<void> | null = null;

  constructor(
    private readonly knowledge: StartupKnowledge,
    private readonly marketplace: StartupMarketplace,
    private readonly skills: StartupSkills,
    private readonly modelCatalog: StartupModelCatalog,
    private readonly providerRuntime: StartupProviderRuntime,
    private readonly backgroundWork: StartupBackgroundWork,
  ) {}

  /**
   * 默认 KB 是启动前置条件；其余索引与远端同步失败时只降级对应能力，
   * 不能阻止用户进入本地应用。
   */
  start(): Promise<void> {
    this.startup ??= this.startOnce();
    return this.startup;
  }

  async shutdown(): Promise<void> {
    await this.backgroundWork.shutdown();
  }

  private async startOnce(): Promise<void> {
    this.seedMarketplace();
    const defaultKbPath = path.join(profileDir(), 'kb-default');
    await this.knowledge.ensureDefault(defaultKbPath);

    // 崩溃恢复和常驻 Worker 先启动，随后的一次性任务不能抢在恢复之前运行。
    this.backgroundWork.start();
    void this.initializeKnowledge();
    void this.reconcileSkills();
    void this.refreshModelCatalog();
    void this.syncBridge();
  }

  private seedMarketplace(): void {
    try {
      this.marketplace.ensureSeeds([...MCP_SEEDS, ...SKILL_SEEDS]);
    } catch (error) {
      console.warn('[marketplace] seed failed:', error);
    }
  }

  private async initializeKnowledge(): Promise<void> {
    try {
      await this.knowledge.initAll();
    } catch (error) {
      console.warn('[kb] initAll() failed:', error);
    }
  }

  private async reconcileSkills(): Promise<void> {
    try {
      await this.skills.scanAndReconcile();
    } catch (error) {
      console.warn('[skill] reconcile failed:', error);
    }
  }

  private async refreshModelCatalog(): Promise<void> {
    try {
      const payload = await this.modelCatalog.refresh();
      if (payload !== null) {
        console.info(
          `[catalog] models.dev loaded (${this.modelCatalog.size} models)`,
        );
        return;
      }
      console.warn(
        '[catalog] models.dev refresh failed; context/capability lookups degraded',
      );
    } catch (error) {
      console.warn('[catalog] models.dev refresh failed:', error);
    }
  }

  private async syncBridge(): Promise<void> {
    try {
      await this.providerRuntime.syncBridge();
    } catch (error) {
      console.warn('[provider-runtime] initial bridge sync failed:', error);
    }
  }
}
