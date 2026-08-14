// 按固定顺序启动 LocalHost 的一次性业务初始化，并统一委托常驻后台生命周期。

import path from 'node:path';
import type { KbManager } from '@ema-agent/knowledge';
import type { McpRegistrySourceStore } from '@ema-agent/mcp';
import type { ModelsDevCatalog } from '@ema-agent/provider';
import type { SkillRegistry } from '@ema-agent/skills';
import type { UsageRecordsRepo } from '@ema-agent/storage';
import { profileDir } from '../storage-locations/index.js';
import type { BackgroundWork } from '../background/backgroundWork.js';
import type { ProviderRuntimeFacade } from '../wiring/provider-runtime.js';
import type { BackgroundProcessRuntime } from '@ema-agent/tools';

const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 10_000;
/** 用量记录保留窗口;量级远未到需要按行数裁剪的程度,超窗一次性删除即可。 */
const USAGE_RETENTION_DAYS = 90;

type StartupKnowledge = Pick<KbManager, 'ensureDefault'>;
type StartupMcpSources = Pick<McpRegistrySourceStore, 'ensureOfficialSeed'>;
type StartupSkills = Pick<SkillRegistry, 'refresh'>;
type StartupModelCatalog = Pick<ModelsDevCatalog, 'refresh' | 'size'>;
type StartupProviderRuntime = Pick<ProviderRuntimeFacade, 'syncNarrativeBridge'>;
type StartupBackgroundWork = Pick<BackgroundWork, 'start' | 'shutdown'>;
type StartupUsageRetention = Pick<UsageRecordsRepo, 'deleteOlderThan'>;

export class LocalHostLifecycle {
  private startup: Promise<void> | null = null;
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(
    private readonly knowledge: StartupKnowledge,
    private readonly mcpSources: StartupMcpSources,
    private readonly skills: StartupSkills,
    private readonly modelCatalog: StartupModelCatalog,
    private readonly providerRuntime: StartupProviderRuntime,
    private readonly backgroundWork: StartupBackgroundWork,
    private readonly backgroundProcesses: Pick<BackgroundProcessRuntime, 'shutdown'>,
    private readonly usageRetention: StartupUsageRetention,
  ) {}

  /** 必需恢复完成后即可 ready；其余能力在后台独立启动并可降级。 */
  start(): Promise<void> {
    this.startup ??= this.startOnce();
    return this.startup;
  }

  async shutdown(): Promise<void> {
    await this.startup;
    await Promise.all([
      this.backgroundProcesses.shutdown(),
      this.backgroundWork.shutdown(),
      ...this.backgroundTasks,
    ]);
  }

  private async startOnce(): Promise<void> {
    // 执行终态恢复属于 ready 前置条件；失败会让 start() 直接拒绝。
    this.backgroundWork.start();

    const defaultKbPath = path.join(profileDir(), 'kb-default');
    await this.runDegraded('mcp registry seed', async () => {
      this.mcpSources.ensureOfficialSeed();
    });
    await this.runDegraded('default KB', () =>
      this.knowledge.ensureDefault(defaultKbPath));

    this.trackBackground('skill registry refresh', async () => {
      await this.skills.refresh();
    });
    this.trackBackground('model catalog refresh', () =>
      this.refreshModelCatalog());
    this.trackBackground('initial Narrative Bridge sync', () =>
      this.providerRuntime.syncNarrativeBridge());
    this.trackBackground('usage retention', () => {
      const cutoff = Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const removed = this.usageRetention.deleteOlderThan(cutoff);
      if (removed > 0) {
        console.info(`[usage] retention: 清理 ${removed} 条 ${USAGE_RETENTION_DAYS} 天前的用量记录`);
      }
    });
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
