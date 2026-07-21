import type { Database } from '@ema-agent/storage';
import type { LanguageModelRuntime } from '@ema-agent/llm';
import type { EmbedRuntime } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { TtsClient } from '@ema-agent/tts';
import type { SttClient } from '@ema-agent/stt';
import type { VisionRouter } from '@ema-agent/vision';
import type { NarrativeClient } from '@ema-agent/narrative-client';
import type { CredentialFacade } from '@ema-agent/credential';
import { loadLlmConfigs } from './providers/llm.js';
import { loadEmbedConfigs } from './providers/embed.js';
import { loadRerankConfigs } from './providers/rerank.js';
import { reloadTtsClient } from './providers/tts.js';
import { reloadSttClient } from './providers/stt.js';
import { reloadVisionRouter } from './providers/vision.js';
import { configureBridge } from './bridge.js';

export interface ProviderRuntimeDependencies {
  profileDb: Database;
  llm: LanguageModelRuntime;
  embed: EmbedRuntime;
  rerank: RerankRuntime;
  tts: TtsClient;
  stt: SttClient;
  vision: VisionRouter;
  narrative: NarrativeClient;
  credentials: CredentialFacade;
}

/**
 * Provider 配置生命周期的 Core 编排 Facade。
 *
 * profile.db 是唯一事实来源。Route 只负责持久化，然后通知本 Facade 读取
 * 完整快照；它不应根据某一行的新 capability 推测需要更新哪些 Router。
 */
export class ProviderRuntimeFacade {
  private bridgeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ProviderRuntimeDependencies) {}

  /**
   * 同步替换全部 TS Provider 运行时。
   * 各 Router 会先构造下一代 Adapter Map，再交换引用。
   */
  refreshProviders(): void {
    const { profileDb, llm, embed, rerank, tts, stt, vision, credentials } = this.deps;
    const llmConfigs = loadLlmConfigs(profileDb, credentials);
    const embedConfigs = loadEmbedConfigs(profileDb, credentials);
    const rerankConfigs = loadRerankConfigs(profileDb, credentials);

    llm.reload(llmConfigs);
    embed.reload(embedConfigs);
    rerank.reload(rerankConfigs);
    reloadTtsClient(tts, profileDb, credentials);
    reloadSttClient(stt, profileDb, credentials);
    reloadVisionRouter(vision, profileDb, credentials);
  }

  /**
   * 串行推送 Bridge 完整快照。
   * 每个队列任务执行时重新读取 DB，因此连续保存不会让旧快照覆盖新快照。
   */
  syncBridge(): Promise<void> {
    this.bridgeQueue = this.bridgeQueue
      .catch(() => undefined)
      .then(async () => {
        await configureBridge(
          this.deps.profileDb,
          this.deps.narrative,
          this.deps.credentials,
        );
      });
    return this.bridgeQueue;
  }

  /** Provider 写入后的统一入口：TS 运行时立即换代，Bridge 后台串行同步。 */
  refresh(): void {
    this.refreshProviders();
    void this.syncBridge().catch((error: unknown) => {
      console.warn('[provider-runtime] bridge sync failed:', error);
    });
  }
}
