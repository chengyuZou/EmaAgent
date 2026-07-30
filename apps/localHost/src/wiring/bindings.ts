// 创建 LocalHost 运行所需的业务模块，并把仍待拆分的对象图留在装配边界。

import type { Database } from '@ema-agent/storage';
import {
  type SessionNotesRepo,
  type SessionStatsRepo,
  type DataDirStatsRepo,
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
  type AttachmentDerivationCache,
  type AttachmentStore,
  type FileAccessFacade,
} from '@ema-agent/attachment';
import type { McpRegistry } from '@ema-agent/mcp';
import type { SkillStore, SkillRunner, SkillInstaller } from '@ema-agent/skills';
import type { MarketRegistry, MarketSourceStore } from '@ema-agent/marketplace';
import { HookBus }       from '@ema-agent/hooks';
import { createTraceSink } from './diagnostic-sink.js';
import type { LanguageModelRuntime } from '@ema-agent/llm';
import {
  type ModelsDevCatalog,
  type ModelCapabilityResolver,
} from '@ema-agent/provider';
import type { EmbedRuntime } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { NarrativeClient } from '@ema-agent/narrative';
import type { CharacterCardStore } from '@ema-agent/characters';
import {
  type TtsRuntime,
  type TtsVoiceHandleCache,
  type AudioArchive,
} from '@ema-agent/tts';
import type { SttRuntime } from '@ema-agent/stt';
import type { VisionRuntime } from '@ema-agent/vision';
import { buildPermissionSubsystem } from './permission-bootstrap.js';
import type { AppInteractionQueue } from './permission-bootstrap.js';
import type { SessionStore } from '@ema-agent/session';
import type { EmotionEngine } from '@ema-agent/emotion';
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
import type { KbSearchResult, KbManager } from '@ema-agent/knowledge';
import type { CommandRunnerPort, SandboxStatusWire } from '@ema-agent/sandbox';
import type {
  BackgroundProcessRuntime,
  ToolExecutionJournal,
  ToolRegistry,
  ToolResultStore,
} from '@ema-agent/tools';
import type {
  AgentRunStore,
  AgentRunTranscriptStore,
} from '@ema-agent/agent';
import type { TaskStore } from '@ema-agent/tasks';
import type { MemoryPlanner } from '@ema-agent/memory';
import { SystemEventBus }  from '../sse/system-bus.js';
import type { ProviderRuntimeFacade } from './provider-runtime.js';
import type { SessionBackupFacade } from '@ema-agent/backup';
import type { CredentialFacade } from '@ema-agent/credential';
import { createSettingsStore } from '../settings/createSettingsStore.js';
import { BackgroundWork } from '../background/backgroundWork.js';
import { StartupRecovery } from '../background/startupRecovery.js';
import { LocalHostLifecycle } from '../bootstrap/startLocalHost.js';
import { createProviderControlPlane } from './createProviderControlPlane.js';
import { createModelExecution } from './createModelExecution.js';
import { createSandboxRuntime } from './createSandboxRuntime.js';
import { createToolInfrastructure } from './createToolInfrastructure.js';
import { createSessionPersistence } from './createSessionPersistence.js';
import { createMemoryRuntime } from './createMemoryRuntime.js';
import { createAttachmentRuntime } from './createAttachmentRuntime.js';
import { createSessionBackup } from './createSessionBackup.js';
import { createExtensionRuntime } from './createExtensionRuntime.js';
import { createKnowledgeRuntime } from './createKnowledgeRuntime.js';
import { createCharacterRuntime } from './createCharacterRuntime.js';

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
  /** Session 级后台 Shell 的调度、日志和终态入口。 */
  backgroundProcesses: BackgroundProcessRuntime;
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
  const {
    session,
    sessionStats,
    storageStats,
    sessionNotes,
  } = createSessionPersistence(dataDb, activeDataDir);

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

  // 角色是 Prompt、Live2D、Emotion 与 TTS 的全局基础，种子不变量失败时禁止发布 ready。
  const { card, emotion } = createCharacterRuntime(profileDb);

  // SettingsStore 必须先于动态执行面创建，运行时只读取已校验的类型化快照。
  const { settings } = createSettingsStore(profileDb.sqlite);
  const systemBus = new SystemEventBus();

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
    backgroundProcesses,
  } = createToolInfrastructure(
    dataDb,
    activeDataDir,
    disableExecuteTools,
    settings,
    event => systemBus.emit(event),
  );

  const invalidateSessionRuntime = (sessionId: SessionId): void => {
    invalidateSessionRunner(sessionId);
  };
  const removeSessionRuntime = (sessionId: SessionId): void => {
    backgroundProcesses.discardSession(sessionId);
    removeSessionRunner(sessionId);
    removeSessionToolState(sessionId);
  };

  // Memory 只在此构造；索引初始化、恢复、tick 与 drain 仍由 BackgroundWork 管理。
  const memory = createMemoryRuntime(
    profileDb,
    dataDb,
    session,
    sessionNotes,
    llm,
    embed,
    rerank,
    settings,
    modelBindings,
    providerEmbedModels,
    event => systemBus.emit(event),
  );

  const {
    attachmentStore,
    attachmentDerivationCache,
    attachmentCacheMaintenance,
  } = createAttachmentRuntime(
    dataDb,
    activeDataDir,
    session,
    settings,
  );
  const sessionBackup = createSessionBackup(
    activeDataDir,
    session,
    sessionStats,
    sessionNotes,
    attachmentStore,
  );

  const {
    mcpRegistry,
    marketRegistry,
    marketSourceStore,
    skillStore,
    skillRunner,
    skillInstaller,
  } = createExtensionRuntime(
    profileDb,
    tools,
    permission,
    localMcpStdioEnabled,
  );

  const { kb, kbSearch } = createKnowledgeRuntime(
    profileDb,
    dataDb,
    settings,
    modelBindings,
    embed,
    rerank,
    vision,
    event => systemBus.emit(event),
    providerEmbedModels,
  );

  const backgroundWork = new BackgroundWork(
    new StartupRecovery(
      activeDataDir,
      memory,
      session,
      agentRunStore,
      toolExecutionJournal,
      backgroundProcesses,
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
    backgroundProcesses,
  );

  return {
    dataDb, activeDataDir, fileAccess, sandboxStatus,
    hooks, lifecycle, session, sessionBackup,
    llm, embed, rerank, narrative, modelCatalog, modelCapabilities,
    card, emotion,
    tts, audioArchive, stt, vision, providerRuntime,
    permission, interactionQueue, askUserRegistry, tools, backgroundProcesses,
    buildAskForTurn, getCommandRunner,
    invalidateSessionRuntime, removeSessionRuntime,
    getSessionToolResultStore, agentRunStore, taskStore,
    toolExecutionJournal, agentRunTranscript,
    memory,
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
