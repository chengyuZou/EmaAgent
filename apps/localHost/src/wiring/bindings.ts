// 创建 LocalHost 运行所需的业务模块，并把仍待拆分的对象图留在装配边界。

import type { Database } from '@ema-agent/storage';
import {
  MemoryNodesRepo, MemoryEdgesRepo, MemoryLazyUpdatesRepo,
  MemoryItemsRepo, SessionNotesRepo, MemoryTasksRepo, PendingFragmentsRepo,
  AttachmentRepo,
  MemorySessionStateRepo, MemoryExtractionRunsRepo,
  McpServersRepo, SkillsRepo,
  MarketSourcesRepo,
  SessionStatsRepo, DataDirStatsRepo,
  AttachmentDerivationsRepo,
  type ProvidersRepo,
  type ModelBindingsRepo,
  type ProviderLlmModelsRepo,
  type ProviderEmbedModelsRepo,
  type ProviderRerankModelsRepo,
  type ProviderTtsModelsRepo,
  type ProviderSttModelsRepo,
  type ProviderVisionModelsRepo,
} from '@ema-agent/storage';
import {
  AttachmentCacheMaintenance,
  AttachmentDerivationCache,
  AttachmentStore,
  attachmentSetting,
  type FileAccessFacade,
} from '@ema-agent/attachment';
import { McpRegistry, McpServerStore }                 from '@ema-agent/mcp';
import { McpMarketAdapter }                            from '@ema-agent/mcp';
import type { McpStdioLaunchIntent }                   from '@ema-agent/mcp';
import { SkillStore, SkillRunner, SkillInstaller }     from '@ema-agent/skills';
import { SkillMarketAdapter }                          from '@ema-agent/skills';
import { MarketRegistry, MarketSourceStore }           from '@ema-agent/marketplace';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { HookBus }       from '@ema-agent/hooks';
import { createTraceSink } from './diagnostic-sink.js';
import {
  removeSessionDir,
  removeTurnFiles,
} from '../storage-locations/index.js';
import type { LanguageModelRuntime } from '@ema-agent/llm';
import {
  type ModelsDevCatalog,
  type ModelCapabilityResolver,
} from '@ema-agent/provider';
import type { EmbedRuntime } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { NarrativeClient } from '@ema-agent/narrative';
import { CharacterCardStore, BUILTIN_CARDS, EMA_CARD_INPUT, EMA_CARD_ID } from '@ema-agent/characters';
import { Live2DModelsRepo } from '@ema-agent/storage';
import {
  type TtsRuntime,
  type TtsVoiceHandleCache,
  type AudioArchive,
} from '@ema-agent/tts';
import type { SttRuntime } from '@ema-agent/stt';
import { asKbVisionAdapter } from './providers/vision.js';
import type { VisionRuntime } from '@ema-agent/vision';
import { buildPermissionSubsystem } from './permission-bootstrap.js';
import type { AppInteractionQueue } from './permission-bootstrap.js';
import { SessionStore }  from '@ema-agent/session';
import { EmotionEngine } from '@ema-agent/emotion';
import {
  PermissionEngine,
  permissionAskTimeoutSetting,
} from '@ema-agent/permission';
import type { SettingsStore } from '@ema-agent/settings';
import type { AskPermissionFn, PermissionStreamEvent } from '@ema-agent/permission';
import type { AskUserInteractionPort } from '@ema-agent/turn-execution';
import type {
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type {
  KbAssetScope,
} from '@ema-agent/turn';
import {
  knowledgeModelsSetting,
  type KbSearchResult,
} from '@ema-agent/knowledge';
import type { CommandRunnerPort, SandboxStatusWire } from '@ema-agent/sandbox';
import type { ToolExecutionJournal, ToolRegistry, ToolResultStore } from '@ema-agent/tools';
import type {
  AgentRunStore,
  AgentRunTranscriptStore,
} from '@ema-agent/agent';
import type { TaskStore } from '@ema-agent/tasks';
import { MemoryPlanner } from '@ema-agent/memory';
import { ContextCompactor } from '@ema-agent/context';
import {
  KbManager,
} from '@ema-agent/knowledge';
import type { IngestOptions } from '@ema-agent/knowledge';
import {
  KbActivationsRepo, KbRegistryRepo,
} from '@ema-agent/storage';
import { SystemEventBus }  from '../sse/system-bus.js';
import type { ProviderRuntimeFacade } from './provider-runtime.js';
import { SessionBackupFacade } from '@ema-agent/backup';
import type { CredentialFacade } from '@ema-agent/credential';
import { createSettingsStore } from '../settings/createSettingsStore.js';
import { BackgroundWork } from '../background/backgroundWork.js';
import { StartupRecovery } from '../background/startupRecovery.js';
import { LocalHostLifecycle } from '../bootstrap/startLocalHost.js';
import { createProviderControlPlane } from './createProviderControlPlane.js';
import { createModelExecution } from './createModelExecution.js';
import { createSandboxRuntime } from './createSandboxRuntime.js';
import { createToolInfrastructure } from './createToolInfrastructure.js';

/**
 * LocalHost 迁移期完整对象图。
 * 只允许 wiring 文件展开，不能继续作为 Route、业务模块或公共包 API 的依赖入口。
 */
export interface AppBindings {
  // ── Storage: two SQLite DBs ─────────────────────────────────────────────────
  // profileDb: ~/.ema-agent/profile.db — provider configs, model bindings,
  //   character cards, app settings. Shared across all registered data dirs.
  // dataDb:    {activeDataDir}/data.db — sessions, memory, audio.
  //   Swapped (sidecar restart required) when the user switches active dataDir.
  dataDb:        Database;
  /** Absolute path of the currently-active data dir — used for file storage. */
  activeDataDir: string;
  /** Provider 凭据加解密的唯一入口；主密钥由 Tauri/OS keychain 提供。 */
  /** 本地附件路径的签发、验证与权威元数据入口。 */
  fileAccess: FileAccessFacade;
  /** 当前机器实际启用的沙箱等级，供系统接口和前端设置页展示。 */
  sandboxStatus: SandboxStatusWire;

  hooks:   HookBus;
  /** LocalHost 一次性初始化、常驻后台工作与关闭入口。 */
  lifecycle: LocalHostLifecycle;
  session: SessionStore;
  /** Session 备份导入的唯一业务入口；流式导出在 ZIP v2 接入同一 Facade。 */
  sessionBackup: SessionBackupFacade;

  // AI clients
  llm:       LanguageModelRuntime;
  embed:     EmbedRuntime;
  rerank:    RerankRuntime;
  /** models.dev LLM/Vision catalog — context window + capabilities by modelsDevId. */
  modelCatalog: ModelsDevCatalog;
  /** 按已配置 Provider 身份解析模型能力，不经过 LLM 执行接口。 */
  modelCapabilities: ModelCapabilityResolver;
  narrative: NarrativeClient;

  // Per-card runtime
  card:    CharacterCardStore;
  emotion: EmotionEngine;

  // TTS Facade — synthesizes assistant text. Voice identity always reads from
  // the active card; provider/model reads from the single `tts` model_bindings
  // row (one binding for all modes).
  tts:         TtsRuntime;
  // Audio archive — per-segment write + per-turn merge, under {activeDataDir}/audio.
  audioArchive: AudioArchive;
  // STT Facade — converts user audio → text (single binding in V1).
  stt:          SttRuntime;
  // Vision Facade — image understanding; used by KB ingest (OCR fallback).
  vision:       VisionRuntime;
  /** Provider 配置到各能力运行时及 Python Bridge 的统一生命周期入口。 */
  providerRuntime: ProviderRuntimeFacade;

  // Agent stack
  permission:        PermissionEngine;
  /** Permission 与 AskUser 共享的 per-Session FIFO 交互队列。 */
  interactionQueue:  AppInteractionQueue;
  /** 根 Turn 的 AskUser 等待端口；内部委托统一 Session 交互队列。 */
  askUserRegistry:   AskUserInteractionPort;
  tools:             ToolRegistry;
  /** Per-turn factory that yields an askPermission callback wired to SSE emit. */
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: PermissionStreamEvent) => void;
  }) => AskPermissionFn;
  /** Per-session sandbox runner — memoised on first call per sessionId. */
  getCommandRunner: (sessionId: SessionId) => CommandRunnerPort | undefined;
  /**
   * Drop a session's cached CommandRunner so the next getCommandRunner()
   * rebuilds it from current state. MUST be called whenever workspaceRoot
   * changes — the runner bakes the root into its sandbox config at
   * construction, so a stale cache means commands keep running (and the
   * sandbox keeps permitting writes) in the OLD workspace.
   */
  invalidateSessionRuntime: (sessionId: SessionId) => void;
  /**
   * 会话删除专用(B-026)：清掉该会话的 Runner 与 Tool Result Store 引用。
   */
  removeSessionRuntime: (sessionId: SessionId) => void;
  /** 按 Session 缓存外置 Tool Result 存储。 */
  getSessionToolResultStore: (sessionId: SessionId) => ToolResultStore;
  /** 子 Agent 实际执行的持久化入口；根 Turn 不会写入该存储。 */
  agentRunStore: AgentRunStore;
  /** 根 Turn 可见的持久工作清单；普通 Subagent 不继承该入口。 */
  taskStore: TaskStore;
  /** 工具副作用执行日志的唯一业务入口。 */
  toolExecutionJournal: ToolExecutionJournal;
  /** 子 Agent 执行追加和查询共用的领域 transcript 存储。 */
  agentRunTranscript: AgentRunTranscriptStore;

  // Memory subsystem
  memory: MemoryPlanner;
  // Context subsystem
  contextCompactor: ContextCompactor;

  // System-wide pub/sub for cross-turn events (memory pipeline, background
  // tasks, card switches, provider health). Backs GET /api/system/events.
  systemBus: SystemEventBus;

  // Repos kept on the binding for route convenience
  providers:            ProvidersRepo;
  /** 用户可编辑设置的类型化入口。 */
  settings:             SettingsStore;
  /** 云端声音上传结果只在当前进程内短期复用，不写入用户设置。 */
  ttsVoiceHandles:      TtsVoiceHandleCache;
  modelBindings:        ModelBindingsRepo;
  providerLlmModels:    ProviderLlmModelsRepo;
  providerEmbedModels:  ProviderEmbedModelsRepo;
  providerRerankModels: ProviderRerankModelsRepo;
  providerTtsModels:    ProviderTtsModelsRepo;
  providerSttModels:    ProviderSttModelsRepo;
  providerVisionModels:  ProviderVisionModelsRepo;
  attachmentStore:  AttachmentStore;
  /** 图片规范化副本与 Vision 文本派生的可回收缓存。 */
  attachmentDerivationCache: AttachmentDerivationCache;
  sessionStats:     SessionStatsRepo;
  storageStats:     DataDirStatsRepo;
  sessionNotes:     SessionNotesRepo;
  mcpRegistry:      McpRegistry;
  /** 市场源注册表 + 通用 store(MCP/Skill 共用,kind 不约束)。 */
  marketRegistry:     MarketRegistry;
  marketSourceStore:  MarketSourceStore;
  skillStore:     SkillStore;
  skillRunner:    SkillRunner;
  skillInstaller: SkillInstaller;

  /** Multi-KB manager. Routes use openActiveEntry() to get the active KB's client/queue. */
  kb: KbManager;
  /** KB hybrid search for the kb_search tool — resolves bound embed/rerank models.
   *  kbIds=[] → active KB; multiple ids → cross-KB merge.
   *  assetScopes: per-KB doc filters from the chat picker (each scope targets one KB).
   *  KBs without a matching scope are searched unfiltered.  */
  kbSearch: (query: string, topK?: number, kbIds?: string[], assetScopes?: KbAssetScope[], sessionId?: string, turnId?: string) => Promise<KbSearchResult>;
}

// ── Build bindings ────────────────────────────────────────────────────────────

/**
 * Construct every Facade. Pure data assembly: no hook registration, no
 * subscriber wiring, no side effects beyond DB reads and Facade construction.
 *
 * The `wire(db)` entry point in ./index.ts orchestrates:
 *   buildBindings(db)      ← this function
 *   registerAllHooks(...)
 *   registerAllEmitters(...)
 */
export interface BuildBindingsArgs {
  profileDb:     Database;
  dataDb:        Database;
  activeDataDir: string;
  credentials:   CredentialFacade;
  fileAccess: FileAccessFacade;
}

export function buildBindings(args: BuildBindingsArgs): AppBindings {
  const { profileDb, dataDb, activeDataDir, credentials, fileAccess } = args;

  // ── LocalHost 基础设施 ──────────────────────────────────────────────────────
  const hooks   = new HookBus({
    traceSink:     createTraceSink(),   // 后端 ring + console；Turn SSE 由 HookBus 的 ctx.emit 发出
    warnAnonymous: process.env['NODE_ENV'] !== 'production',
  });
  const session = new SessionStore({
    db: dataDb,
    // Remove the session's on-disk directory tree (audio/scratchpad)
    // when the session is deleted. DB rows cascade via FK; files need this.
    onSessionRemoved: (sid) => removeSessionDir(activeDataDir, sid),
    onTurnRemoved: (sid, tid) => removeTurnFiles(activeDataDir, sid, tid),
  });

  // Provider 控制面先完成凭据迁移、仓库和能力目录装配，执行面只消费其稳定输出。
  const {
    providers,
    providerLlmModels,
    providerEmbedModels,
    providerRerankModels,
    providerTtsModels,
    providerSttModels,
    providerVisionModels,
    modelBindings,
    modelCatalog,
    modelCapabilities,
  } = createProviderControlPlane(profileDb, credentials);

  // ── Character + emotion ─────────────────────────────────────────────────────
  // 角色种子是 EmotionEngine 的构造前置条件，不是可延迟的后台初始化。
  // character_cards.live2d_model_id 具有外键，必须先补内置 Live2D 模型再补角色卡。
  const live2dModelsRepo = new Live2DModelsRepo(profileDb.sqlite);
  for (const builtinCard of BUILTIN_CARDS) {
    if (!builtinCard.live2dModelId) continue;
    if (!live2dModelsRepo.findById(builtinCard.live2dModelId)) {
      const cardId = builtinCard === EMA_CARD_INPUT ? EMA_CARD_ID : builtinCard.name;
      const now = Date.now();
      live2dModelsRepo.insert({
        id:           builtinCard.live2dModelId,
        name:         builtinCard.name,
        format:       'live2d',
        storage_path: `cards/${cardId}/live2d/${builtinCard.live2dModelId}.model3.json`,
        params_json:  '{}',
        is_builtin:   1,
        created_at:   now,
        updated_at:   now,
      });
    }
  }
  const card = new CharacterCardStore({ db: profileDb });
  card.ensureSeed();
  const emotion = new EmotionEngine({ vocabulary: card.current().emotionVocabulary });

  // SettingsStore 必须先于动态执行面创建，运行时只读取已校验的类型化快照。
  const { settings } = createSettingsStore(profileDb.sqlite);

  // 六类模型执行器保持无 Session 状态；网络请求只在具体操作发生时启动。
  const {
    usageRecords,
    llm,
    embed,
    rerank,
    narrative,
    tts,
    ttsVoiceHandles,
    stt,
    vision,
    providerRuntime,
    audioArchive,
  } = createModelExecution(
    profileDb,
    dataDb,
    activeDataDir,
    credentials,
    settings,
    modelCapabilities,
  );

  // ── Repos ───────────────────────────────────────────────────────────────────
  // ── Permission subsystem ────────────────────────────────────────────────────
  const { permission, interactionQueue, askUserRegistry, buildAskForTurn } =
    buildPermissionSubsystem(
      settings.get(permissionAskTimeoutSetting),
      profileDb.sqlite,
    );

  // Sandbox 先冻结本机安全能力，工具表据此决定是否暴露 Execute 类工具。
  const {
    sandboxStatus,
    disableExecuteTools,
    localMcpStdioEnabled,
    getCommandRunner,
    invalidateSessionRunner,
    removeSessionRunner,
  } = createSandboxRuntime(session, activeDataDir);
  const {
    tools,
    getSessionToolResultStore,
    removeSessionToolState,
    toolResultCleaner,
    agentRunTranscript,
    agentRunStore,
    taskStore,
    toolExecutionJournal,
  } = createToolInfrastructure(dataDb, activeDataDir, disableExecuteTools);

  const invalidateSessionRuntime = (sessionId: SessionId): void => {
    invalidateSessionRunner(sessionId);
  };
  const removeSessionRuntime = (sessionId: SessionId): void => {
    removeSessionRunner(sessionId);
    removeSessionToolState(sessionId);
  };

  // ── System event bus ────────────────────────────────────────────────────────
  const systemBus = new SystemEventBus();

  // ── Memory ──────────────────────────────────────────────────────────────────
  const memoryNodes          = new MemoryNodesRepo(profileDb.sqlite);
  const memoryEdges          = new MemoryEdgesRepo(profileDb.sqlite);
  const memoryLazyUpdates    = new MemoryLazyUpdatesRepo(profileDb.sqlite);
  const memoryItems          = new MemoryItemsRepo(profileDb.sqlite);
  const memoryExtractionRuns = new MemoryExtractionRunsRepo(profileDb.sqlite);
  const memorySessionNotes   = new SessionNotesRepo(dataDb.sqlite);
  const pendingFragments     = new PendingFragmentsRepo(dataDb.sqlite);

  const memory = new MemoryPlanner({
    session,
    llm,
    embedRuntime: embed,
    rerankRuntime: rerank,
    modelBindings,
    nodes:            memoryNodes,
    edges:            memoryEdges,
    lazyUpdates:      memoryLazyUpdates,
    items:            memoryItems,
    sessionNotes:     memorySessionNotes,
    memoryTasks:      new MemoryTasksRepo(dataDb.sqlite),
    pendingFragments,
    memorySessionState: new MemorySessionStateRepo(dataDb.sqlite),
    extractionRuns:     memoryExtractionRuns,
    runProfileTransaction: <T>(work: () => T): T => profileDb.sqlite.transaction(work)(),
    runDataTransaction:    <T>(work: () => T): T => dataDb.sqlite.transaction(work)(),
    // dim is probed at enable time and stored on provider_embed_models (dim_source='probed').
    getEmbedDim:      (providerId, model) => providerEmbedModels.dimFor(providerId, model) ?? 0,
    emit:             (ev) => systemBus.emit(ev),
  });

  const contextCompactor = new ContextCompactor({
    llm,
    hookBus: hooks,
    loadSessionNote: (sessionId) => memory.loadSessionNote(sessionId),
    persistSummary: (input) => session.appendMessage(input),
  });

  // ── Attachments ─────────────────────────────────────────────────────────────
  const attachmentStore = new AttachmentStore(new AttachmentRepo(dataDb.sqlite), session);
  const attachmentDerivationsRepo = new AttachmentDerivationsRepo(dataDb.sqlite);
  const attachmentDerivationCache = new AttachmentDerivationCache({
    activeDataDir,
    repo: attachmentDerivationsRepo,
  });
  const attachmentCacheMaintenance = new AttachmentCacheMaintenance({
    activeDataDir,
    repo: attachmentDerivationsRepo,
    isIdle: () => !session.hasActiveTurns(),
    maxBytesForSweep: () => settings.get(attachmentSetting).derivationCacheBytes,
  });

  // ── Session detail (stats + notes) — used by /api/sessions/:id/dashboard ──
  const sessionStats = new SessionStatsRepo(dataDb.sqlite);
  const storageStats = new DataDirStatsRepo(dataDb.sqlite);
  const sessionNotes = new SessionNotesRepo(dataDb.sqlite);
  const sessionBackup = new SessionBackupFacade({
    activeDataDir,
    sessionExists: (sessionId) => session.sessionExists(sessionId as SessionId),
    restoreRows: (payload) => sessionStats.restoreRows(payload),
    collectExport: (sessionId) => {
      const id = sessionId as SessionId;
      if (!session.sessionExists(id)) return null;
      const sessionRow = session.getSession(id);
      const noteRow = sessionNotes.findBySession(id);
      return {
        session: { ...sessionRow },
        turns: session.listTurns(id, 10_000),
        messages: session.listMessages(id, { limit: 10_000 }),
        attachments: attachmentStore.listBySession(sessionId),
        audio: sessionStats.listAudioEntries(sessionId),
        notes: noteRow ? {
          sessionId,
          body: noteRow.body,
          tokensAtLastUpdate: noteRow.tokens_at_last_update,
          updatedAt: noteRow.updated_at,
        } : null,
        tasks: sessionStats.listTasks(sessionId),
        taskDependencies: sessionStats.listTaskDependencies(sessionId),
        agentRuns: sessionStats.listAgentRuns(sessionId),
        agentRunMessages: sessionStats.listAgentRunMessages(sessionId),
        memoryState: sessionStats.getMemoryState(sessionId) ?? null,
        kbActivations: sessionStats.listKbActivations(sessionId),
        usageRecords: sessionStats.listUsageRecords(sessionId),
      };
    },
  });

  // ── MCP registry ────────────────────────────────────────────────────────────
  const mcpStdioGate = async (intent: McpStdioLaunchIntent): Promise<boolean> => {
    if (!localMcpStdioEnabled) return false;
    // 环境变量值可能包含 API Key；授权界面只展示键名，但 Registry 会把批准
    // 绑定在这次冻结 intent 上，并使用同一份配置启动进程。
    const environmentKeys = Object.keys(intent.environment ?? {}).sort();
    const outcome = await permission.gate(
      'mcp_stdio_launch',
      {
        operation: intent.operation,
        serverName: intent.serverName,
        command: intent.command,
        args: [...intent.args],
        cwd: intent.cwd ?? null,
        environmentKeys,
      },
      { riskLevel: 'high', accessType: 'execute' },
      { workspaceRoot: process.cwd() },
    );
    return outcome.granted;
  };
  const mcpRegistry = new McpRegistry(
    new McpServerStore(new McpServersRepo(profileDb.sqlite)),
    tools,
    mcpStdioGate,
    localMcpStdioEnabled,
  );
  // ── Marketplace(多源聚合底座,MCP/Skill 共用)──────────────────────────────
  // 纯底座:adapter 注册表 + 通用源 store。各业务包(MCP/Skill)实现自己的 adapter
  // kind 不约束,未来 integration(QQ/微信/邮箱)零改底座接入。
  const marketRegistry    = new MarketRegistry();
  const marketSourceStore = new MarketSourceStore(new MarketSourcesRepo(profileDb.sqlite));
  marketRegistry.registerAdapter(new McpMarketAdapter());
  marketRegistry.registerAdapter(new SkillMarketAdapter());

  // ── Skills ───────────────────────────────────────────────────────────────────
  // File-backed: SKILL.md files live under the profile dir (cross-dataDir,
  // mirrors where profile.db lives). The SQL index in profile.db is a cache.
  const skillsUserRoot = nodePath.join(os.homedir(), '.ema-agent', 'skills');
  const skillStore     = new SkillStore(new SkillsRepo(profileDb.sqlite), [
    // builtin (read-only) root could be prepended here once skills ship with the app.
    { path: skillsUserRoot, source: 'user' },
  ]);
  const skillRunner    = new SkillRunner(skillStore);
  const skillInstaller = new SkillInstaller(skillStore);
  // ── Knowledge base ───────────────────────────────────────────────────────────
  const resolveIngestModels = (): Partial<IngestOptions> => {
    const kbModels = settings.get(knowledgeModelsSetting);
    const visionB = modelBindings.get('vision');
    return {
      ebdProviderId:    kbModels.embed?.providerConfigId,
      ebdModel:         kbModels.embed?.model,
      visionProviderId: visionB?.providerConfigId,
      visionModel:      visionB?.model,
    };
  };

  const kb = new KbManager({
    registry:             new KbRegistryRepo(profileDb.sqlite),
    activations:          new KbActivationsRepo(dataDb.sqlite),
    embedRuntime:         embed,
    rerankRuntime:        rerank,
    visionAdapter:        asKbVisionAdapter(vision),
    resolveIngestOptions: resolveIngestModels,
    concurrency:          3,
  });

  // Bridge KbManager's aggregated event bus → systemBus SSE.
  // kbId is now injected by KbManager.openEntry; forward it on every event type.
  kb.events.on((e) => {
    const kbId = e.kbId ?? '';

    // 重建索引事件走独立的 kb_reembed_* SSE, 不与入库进度混淆。
    if (e.operation === 'reembed') {
      if (e.kind === 'complete') {
        systemBus.emit({
          type: 'kb_reembed_completed', kbId, taskId: e.taskId, assetId: e.assetId,
          totalItems: e.totalItems ?? 0, completedItems: e.completedItems ?? 0, failedItems: e.failedItems ?? 0,
        });
        return;
      }
      if (e.kind === 'partial_failed') {
        systemBus.emit({
          type: 'kb_reembed_partial_failed', kbId, taskId: e.taskId, assetId: e.assetId,
          error: e.error ?? '部分文档重建失败',
          totalItems: e.totalItems ?? 0, completedItems: e.completedItems ?? 0, failedItems: e.failedItems ?? 0,
        });
        return;
      }
      if (e.kind === 'cancelled') {
        systemBus.emit({ type: 'kb_reembed_cancelled', kbId, taskId: e.taskId, assetId: e.assetId });
        return;
      }
      if (e.kind === 'error') {
        systemBus.emit({ type: 'kb_reembed_failed', kbId, taskId: e.taskId, assetId: e.assetId, error: e.error ?? 'unknown' });
        return;
      }
      systemBus.emit({
        type: 'kb_reembed_progress', kbId, taskId: e.taskId, assetId: e.assetId,
        progress: e.progress ?? 0,
        totalItems: e.totalItems, completedItems: e.completedItems, failedItems: e.failedItems,
      });
      return;
    }
    if (e.kind === 'complete') {
      systemBus.emit({ type: 'kb_ingest_completed', kbId, taskId: e.taskId, assetId: e.assetId });
      return;
    }
    if (e.kind === 'partial_failed') {
      systemBus.emit({
        type: 'kb_ingest_partial_failed',
        kbId,
        taskId: e.taskId,
        assetId: e.assetId,
        error: e.error ?? '部分处理项失败',
        totalItems: e.totalItems ?? 0,
        completedItems: e.completedItems ?? 0,
        failedItems: e.failedItems ?? 0,
      });
      return;
    }
    if (e.kind === 'error') {
      systemBus.emit({ type: 'kb_ingest_failed', kbId, taskId: e.taskId, assetId: e.assetId, error: e.error ?? 'unknown' });
      return;
    }
    // cancelled 只属于 reembed。畸形事件不得伪装成 ingest 进度进入前端状态机。
    if (e.kind === 'cancelled') return;
    const base: Record<string, number> = { validate: 0.05, parse: 0.25, chunk: 0.45, embed: 0.5 };
    const progress = e.kind === 'embed' ? 0.5 + 0.5 * (e.progress ?? 0) : (base[e.kind] ?? 0);
    systemBus.emit({
      type: 'kb_ingest_progress',
      kbId,
      taskId: e.taskId,
      assetId: e.assetId,
      stage: e.kind,
      progress,
      totalItems: e.totalItems,
      completedItems: e.completedItems,
      failedItems: e.failedItems,
    });
  });

  // kb_search tool injection: resolves bound embed/rerank models and threads
  // kbIds (LLM override) + assetScopes (user picker) into KbManager.search().
  const kbSearch = (
    query:        string,
    topK?:        number,
    kbIds?:       string[],
    assetScopes?: KbAssetScope[],
    sessionId?:   string,
    turnId?:      string,
  ): Promise<KbSearchResult> => {
    const kbModels = settings.get(knowledgeModelsSetting);
    // kbIds=[] / undefined → KbManager falls back to the active KB.
    // assetScopes let KbManager route per-KB doc filters to the right client.
    return kb.search(kbIds ?? [], query, {
      assetScopes,
      topK,
      sessionId,
      turnId,
      ebdProviderId:    kbModels.embed?.providerConfigId,
      ebdModel:         kbModels.embed?.model,
      rerankProviderId: kbModels.rerank?.providerConfigId,
      rerankModel:      kbModels.rerank?.model,
    });
  };

  const backgroundWork = new BackgroundWork(
    new StartupRecovery(
      activeDataDir,
      memory,
      session,
      agentRunStore,
      toolExecutionJournal,
    ),
    memory,
    mcpRegistry,
    toolResultCleaner,
    attachmentCacheMaintenance,
    narrative,
    providerRuntime,
    systemBus,
  );
  const lifecycle = new LocalHostLifecycle(
    kb,
    marketSourceStore,
    skillStore,
    modelCatalog,
    providerRuntime,
    backgroundWork,
  );

  return {
    dataDb, activeDataDir, fileAccess, sandboxStatus,
    hooks, lifecycle, session, sessionBackup,
    llm, embed, rerank, narrative, modelCatalog, modelCapabilities,
    card, emotion,
    tts, audioArchive, stt, vision, providerRuntime,
    permission, interactionQueue, askUserRegistry, tools, buildAskForTurn, getCommandRunner,
    invalidateSessionRuntime, removeSessionRuntime,
    getSessionToolResultStore, agentRunStore, taskStore,
    toolExecutionJournal, agentRunTranscript,
    memory, contextCompactor,
    systemBus,
    providers, settings, ttsVoiceHandles,
    modelBindings, providerLlmModels, providerEmbedModels,
    providerRerankModels, providerTtsModels, providerSttModels, providerVisionModels,
    attachmentStore, attachmentDerivationCache,
    sessionStats, storageStats, sessionNotes,
    mcpRegistry,
    marketRegistry, marketSourceStore,
    skillStore, skillRunner, skillInstaller,
    kb, kbSearch,
  };
}

// ── Re-exports for routes that import directly from this module ───────────────
export { buildLlmProviderConfig }   from './providers/llm.js';
export { buildEmbedProviderConfig } from './providers/embed.js';
export { buildRerankProviderConfig } from './providers/rerank.js';
