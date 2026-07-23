// 创建 Core 运行所需的业务模块，并把它们装配到统一 AppBindings。

import type { Database } from '@ema-agent/storage';
import {
  ModelBindingsRepo,
  ProvidersRepo,
  SettingsRepo,
  MemoryNodesRepo, MemoryEdgesRepo, MemoryLazyUpdatesRepo,
  MemoryItemsRepo, SessionNotesRepo, MemoryTasksRepo, PendingFragmentsRepo,
  ArtifactRepo, AttachmentRepo,
  MemorySessionStateRepo, MemoryExtractionRunsRepo,
  ProviderLlmModelsRepo, ProviderEmbedModelsRepo,
  ProviderRerankModelsRepo, ProviderTtsModelsRepo, ProviderSttModelsRepo, ProviderVisionModelsRepo,
  McpServersRepo, SkillsRepo,
  MarketSourcesRepo,
  AgentRunsRepo, AgentRunMessagesRepo, TasksRepo, ToolExecutionsRepo,
  SessionStatsRepo, DataDirStatsRepo, UsageRecordsRepo,
} from '@ema-agent/storage';
import { AttachmentStore, type FileAccessFacade } from '@ema-agent/attachment';
import { ArtifactStore }                               from '@ema-agent/artifact';
import { McpRegistry, McpServerStore }                 from '@ema-agent/mcp';
import { McpMarketAdapter, MCP_SEEDS }                 from '@ema-agent/mcp';
import type { McpStdioLaunchIntent }                   from '@ema-agent/mcp';
import { SkillStore, SkillRunner, SkillInstaller }     from '@ema-agent/skills';
import { SkillMarketAdapter, SKILL_SEEDS }             from '@ema-agent/skills';
import { MarketRegistry, MarketSourceStore }           from '@ema-agent/marketplace';
import * as nodePath from 'node:path';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { HookBus }       from '@ema-agent/hooks';
import { createTraceSink } from './diagnostic-sink.js';
import {
  dataDbPathFor,
  profileDbPath,
  removeSessionDir,
  removeTurnFiles,
  sqliteFileSet,
} from '../storage-locations/index.js';
import { LanguageModelRuntime } from '@ema-agent/llm';
import {
  createModelCapabilityResolver,
  modelsDevIdFor,
  providerCatalog,
  ModelsDevCatalog,
  type ModelCapabilityResolver,
} from '@ema-agent/provider';
import { EmbedRuntime } from '@ema-agent/embed';
import { RerankRuntime } from '@ema-agent/rerank';
import { NarrativeClient } from '@ema-agent/narrative';
import { CharacterCardStore, BUILTIN_CARDS, EMA_CARD_INPUT, EMA_CARD_ID } from '@ema-agent/characters';
import { Live2DModelsRepo } from '@ema-agent/storage';
import { TtsRuntime, FsAudioArchive, type AudioArchive } from '@ema-agent/tts';
import { SttRuntime } from '@ema-agent/stt';
import { buildTtsRuntime } from './providers/tts.js';
import { buildSttRuntime } from './providers/stt.js';
import { buildVisionRuntime, asKbVisionAdapter } from './providers/vision.js';
import { VisionRuntime } from '@ema-agent/vision';
import { loadLlmConfigs }   from './providers/llm.js';
import { loadEmbedConfigs }  from './providers/embed.js';
import { loadRerankConfigs } from './providers/rerank.js';
import { buildPermissionSubsystem } from './permission-bootstrap.js';
import { SessionStore }  from '@ema-agent/session';
import { EmotionEngine } from '@ema-agent/emotion';
import { PermissionEngine } from '@ema-agent/permission';
import type { AskPermissionFn } from '@ema-agent/permission';
import { PermissionPromptRegistry } from '../permissions/registry.js';
import { AskUserRegistry }          from '../ask-user/registry.js';
import type {
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type {
  EmaStreamEvent,
  KbAssetScope,
} from '@ema-agent/turn';
import type { KbSearchResult } from '@ema-agent/knowledge';
import type { ReleaseFeaturesWire } from '@ema-agent/system';
import type { SandboxStatusWire } from '@ema-agent/sandbox';
import type { UsageRecord } from '@ema-agent/usage';
import { SessionFileStateStore, ToolExecutionJournal, ToolRegistry } from '@ema-agent/tools';
import {
  cleanupInterruptedFileWriteTemps,
  registerBuiltinTools,
} from '@ema-agent/tool-builtin';
import { detectBackend, CommandRunner } from '@ema-agent/sandbox';
import { ToolResultCleaner, ToolResultStore } from '@ema-agent/tools';
import type { ICommandRunner, IMcpClientBridge, ISkillRunner } from '@ema-agent/tools';
import { AgentRunStore } from '@ema-agent/agent';
import { TaskStore } from '@ema-agent/tasks';
import { MemoryPlanner } from '@ema-agent/memory';
import { ContextCompactor } from '@ema-agent/context';
import {
  KbManager,
} from '@ema-agent/knowledge';
import type { IngestOptions } from '@ema-agent/knowledge';
import {
  KbActivationsRepo, KbRegistryRepo,
} from '@ema-agent/storage';
import { resolveBridgeUrl } from './bridge.js';
import { SystemEventBus }  from '../sse/system-bus.js';
import { ProviderRuntimeFacade } from './provider-runtime.js';
import { SessionBackupFacade } from '@ema-agent/backup';
import type { CredentialFacade } from '@ema-agent/credential';

// ── App-wide bindings (Facade set passed everywhere) ─────────────────────────

/**
 * The complete dependency surface for all routes / orchestrator / engines.
 *
 * Kept flat — sub-bundles were considered but would force a refactor of every
 * route handler that already reads `bindings.session`, `bindings.llm`, etc.
 * We revisit splitting if the field count meaningfully exceeds ~20.
 */
export interface AppBindings {
  // ── Storage: two SQLite DBs ─────────────────────────────────────────────────
  // profileDb: ~/.ema-agent/profile.db — provider configs, model bindings,
  //   character cards, app settings. Shared across all registered data dirs.
  // dataDb:    {activeDataDir}/data.db — sessions, memory, audio, artifacts.
  //   Swapped (sidecar restart required) when the user switches active dataDir.
  profileDb:     Database;
  dataDb:        Database;
  /** Absolute path of the currently-active data dir — used for file storage. */
  activeDataDir: string;
  /** Provider 凭据加解密的唯一入口；主密钥由 Tauri/OS keychain 提供。 */
  credentials: CredentialFacade;
  /** 本地附件路径的签发、验证与权威元数据入口。 */
  fileAccess: FileAccessFacade;
  /** 当前机器实际启用的沙箱等级，供系统接口和前端设置页展示。 */
  sandboxStatus: SandboxStatusWire;

  hooks:   HookBus;
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
  permissionPrompts: PermissionPromptRegistry;
  /** In-memory registry for pending ask_user prompts. */
  askUserRegistry:   AskUserRegistry;
  tools:             ToolRegistry;
  /** Per-turn factory that yields an askPermission callback wired to SSE emit. */
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: EmaStreamEvent) => void;
  }) => AskPermissionFn;
  /** Per-session sandbox runner — memoised on first call per sessionId. */
  getCommandRunner: (sessionId: SessionId) => ICommandRunner;
  /**
   * Drop a session's cached CommandRunner so the next getCommandRunner()
   * rebuilds it from current state. MUST be called whenever workspaceRoot
   * changes — the runner bakes the root into its sandbox config at
   * construction, so a stale cache means commands keep running (and the
   * sandbox keeps permitting writes) in the OLD workspace.
   */
  invalidateSessionRuntime: (sessionId: SessionId) => void;
  /**
   * 会话删除专用(B-026): 清掉该会话的 runner 缓存和 context stores。
   * 与 invalidateSessionRuntime(workspace 变更, 文件状态历史仍有用)不同,
   * 会话已删除时这些历史永久驻留即内存泄漏。
   */
  removeSessionRuntime: (sessionId: SessionId) => void;
  /** Per-session file-state + tool-result store — memoised on first call. */
  getSessionToolStores: (sessionId: SessionId) => {
    fileStateStore:  SessionFileStateStore;
    toolResultStore: ToolResultStore;
  };
  /** Sweeps offloaded tool-result files — called by background tick. */
  toolResultCleaner: ToolResultCleaner;
  /** 子 Agent 实际执行的持久化入口；根 Turn 不会写入该存储。 */
  agentRunStore: AgentRunStore;
  /** 根 Turn 可见的持久工作清单；普通 Subagent 不继承该入口。 */
  taskStore: TaskStore;
  /** 工具副作用执行日志的唯一业务入口。 */
  toolExecutionJournal: ToolExecutionJournal;
  /** SSE 转录投影写入子 Agent 消息的存储入口。 */
  agentRunMessages: AgentRunMessagesRepo;

  // Memory subsystem
  memory: MemoryPlanner;
  // Context subsystem
  contextCompactor: ContextCompactor;

  // System-wide pub/sub for cross-turn events (memory pipeline, background
  // tasks, card switches, provider health). Backs GET /api/system/events.
  systemBus: SystemEventBus;

  // Repos kept on the binding for route convenience
  providers:            ProvidersRepo;
  settings:             SettingsRepo;
  modelBindings:        ModelBindingsRepo;
  providerLlmModels:    ProviderLlmModelsRepo;
  providerEmbedModels:  ProviderEmbedModelsRepo;
  providerRerankModels: ProviderRerankModelsRepo;
  providerTtsModels:    ProviderTtsModelsRepo;
  providerSttModels:    ProviderSttModelsRepo;
  providerVisionModels:  ProviderVisionModelsRepo;
  artifactStore:    ArtifactStore;
  attachmentStore:  AttachmentStore;
  sessionStats:     SessionStatsRepo;
  storageStats:     DataDirStatsRepo;
  sessionNotes:     SessionNotesRepo;
  mcpRegistry:      McpRegistry;
  /** Thin adapter satisfying IMcpClientBridge — delegates to mcpRegistry.callTool(). */
  mcpBridge:        IMcpClientBridge;
  /** 市场源注册表 + 通用 store(MCP/Skill 共用,kind 不约束)。 */
  marketRegistry:     MarketRegistry;
  marketSourceStore:  MarketSourceStore;
  /** Thin adapter satisfying ISkillRunner — looks up skill body from skillStore. */
  skillBridge:      ISkillRunner;
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

  /** V1 发布特性开关。工具注册、路由挂载、capabilities endpoint 都从此读取。 */
  releaseFeatures: ReleaseFeaturesWire;
}

// ── V1 发布特性 ────────────────────────────────────────────────────────────────

/**
 * V1 默认发布特性。Artifact 属于 V1.5 预留能力,V1 默认关闭。
 * 完成状态机(B-003/B-068/B-069)前不得在生产开启。
 * 测试可通过 BuildBindingsArgs.releaseFeatures 显式注入。
 */
const V1_RELEASE_FEATURES: ReleaseFeaturesWire = Object.freeze({ artifacts: false });

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
  /** 仅用于测试显式注入;正常生产不传,始终采用 V1_RELEASE_FEATURES。 */
  releaseFeatures?: ReleaseFeaturesWire;
}

export function buildBindings(args: BuildBindingsArgs): AppBindings {
  const { profileDb, dataDb, activeDataDir, credentials, fileAccess } = args;
  const releaseFeatures = args.releaseFeatures ?? V1_RELEASE_FEATURES;

  // ── Core infra ──────────────────────────────────────────────────────────────
  const hooks   = new HookBus({
    traceSink:     createTraceSink(),   // 后端 ring + console；Turn SSE 由 HookBus 的 ctx.emit 发出
    warnAnonymous: process.env['NODE_ENV'] !== 'production',
  });
  const session = new SessionStore({
    db: dataDb,
    // Remove the session's on-disk directory tree (audio/artifacts/scratchpad)
    // when the session is deleted. DB rows cascade via FK; files need this.
    onSessionRemoved: (sid) => removeSessionDir(activeDataDir, sid),
    onTurnRemoved: (sid, tid) => removeTurnFiles(activeDataDir, sid, tid),
  });

  // ── Per-provider model pools (profileDb) ────────────────────────────────────
  const providers            = new ProvidersRepo(profileDb.sqlite, credentials);
  const migratedCredentials  = providers.protectLegacyCredentials();
  if (migratedCredentials > 0) {
    console.info(`[credential] 已加密迁移 ${migratedCredentials} 个旧 Provider 凭据`);
  }
  const providerLlmModels    = new ProviderLlmModelsRepo(profileDb.sqlite);
  const providerEmbedModels  = new ProviderEmbedModelsRepo(profileDb.sqlite);
  const providerRerankModels = new ProviderRerankModelsRepo(profileDb.sqlite);
  const providerTtsModels    = new ProviderTtsModelsRepo(profileDb.sqlite);
  const providerSttModels    = new ProviderSttModelsRepo(profileDb.sqlite);
  const providerVisionModels = new ProviderVisionModelsRepo(profileDb.sqlite);
  const usageRecords         = new UsageRecordsRepo(dataDb.sqlite);
  const onUsageRecordError = (error: unknown, record: UsageRecord): void => {
    console.error(`[usage] 调用记录写入失败: ${record.id}`, error);
  };

  // ── AI clients (provider configs live in profileDb) ────────────────────────
  // models.dev catalog: load bundled snapshot first (instant, offline-safe),
  // then refresh from network in the background. Consumers get catalog data
  // immediately from the snapshot; the refresh updates it silently.
  // 必须先构造模型目录，语言模型运行时才能据此解析推理与多模态能力。
  const modelCatalog = new ModelsDevCatalog();
  try {
    const snapshotPath = nodePath.join(import.meta.dirname!, '..', 'models-dev-snapshot.json');
    modelCatalog.loadFromJson(JSON.parse(readFileSync(snapshotPath, 'utf8')));
    console.info(`[catalog] loaded bundled snapshot (${modelCatalog.size} models)`);
  } catch {
    console.warn('[catalog] no bundled snapshot found, will rely on network refresh');
  }
  const catalogModelCapabilities = createModelCapabilityResolver(modelCatalog, {
    supportsManualImageInput: (providerId, model) =>
      providerVisionModels.hasProviderModel(providerId, model),
  });
  const modelCapabilities: ModelCapabilityResolver = {
    resolve(query) {
      const providerRow = providers.get(query.providerId);
      const definition = providerRow
        ? providerCatalog.get(providerRow.definition_id)
        : undefined;
      const modelsDevId = query.modelsDevId
        ?? (definition ? modelsDevIdFor(definition, 'llm') : undefined);
      return catalogModelCapabilities.resolve({
        ...query,
        ...(modelsDevId ? { modelsDevId } : {}),
      });
    },
  };
  const llm = new LanguageModelRuntime(loadLlmConfigs(profileDb, credentials), undefined, {
    modelCapabilities,
    usageRecorder: usageRecords,
    onUsageRecordError,
  });
  const embed = new EmbedRuntime(
    loadEmbedConfigs(profileDb, credentials),
    { usageRecorder: usageRecords, onUsageRecordError },
  );
  const rerank = new RerankRuntime(
    loadRerankConfigs(profileDb, credentials),
    { usageRecorder: usageRecords, onUsageRecordError },
  );

  const narrative = new NarrativeClient({
    baseUrl:   resolveBridgeUrl(),
    secret:    process.env['EMA_SHARED_SECRET'],
    timeoutMs: 60_000,
  });

  // ── Character + emotion ─────────────────────────────────────────────────────
  // Seed built-in Live2D models FIRST — character_cards.live2d_model_id has an
  // FK to live2d_models(id), so the model row must exist before the card insert.
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

  // ── TTS / STT ───────────────────────────────────────────────────────────────
  const tts    = buildTtsRuntime({ profileDb, credentials, usageRecorder: usageRecords, onUsageRecordError });
  const stt    = buildSttRuntime({ profileDb, credentials, usageRecorder: usageRecords, onUsageRecordError });
  const vision = buildVisionRuntime(profileDb, credentials, usageRecords, onUsageRecordError);
  const providerRuntime = new ProviderRuntimeFacade({
    profileDb,
    llm,
    embed,
    rerank,
    tts,
    stt,
    vision,
    narrative,
    credentials,
  });

  // ── Audio archive ───────────────────────────────────────────────────────────
  // Per-session: {dataDir}/sessions/{sessionId}/audio/. Collocated with
  // artifacts/scratchpad so removeSessionDir cleans everything together.
  const audioArchive = new FsAudioArchive(
    nodePath.join(activeDataDir, 'sessions'),
  );

  // ── Repos ───────────────────────────────────────────────────────────────────
  const modelBindings = new ModelBindingsRepo(profileDb.sqlite);

  // ── Permission subsystem ────────────────────────────────────────────────────
  const settingsRepo = new SettingsRepo(profileDb.sqlite);
  const { permission, permissionPrompts, askUserRegistry, buildAskForTurn } =
    buildPermissionSubsystem(settingsRepo);

  // ── Tools + sandbox ─────────────────────────────────────────────────────────
  // On Windows without WSL2+bubblewrap the backend is 'app-layer' (no OS
  // isolation). Shell tools are disabled unless AGEN_UNSAFE_SHELL=1 is set.
  const sandboxDetection   = detectBackend();
  const unsafeShellOverride = process.env['AGEN_UNSAFE_SHELL'] === '1';
  const unsafeMcpOverride   = process.env['AGEN_UNSAFE_MCP_STDIO'] === '1';
  const sandboxNetworkAccess = process.env['AGEN_UNSAFE_SANDBOX_NETWORK'] === '1'
    ? 'full' as const
    : 'none' as const;
  const disableExecuteTools =
    sandboxDetection.backend === 'app-layer' &&
    !unsafeShellOverride;

  // stdio MCP 目前由 SDK 直接启动，不经过 CommandRunner，所以默认禁用。
  // 显式环境变量只用于开发者自行承担风险，不代表它获得了系统沙箱。
  const localMcpStdioEnabled = unsafeMcpOverride;
  const sandboxWarnings = [
    sandboxDetection.degradeReason,
    sandboxDetection.backend === 'app-layer' && unsafeShellOverride
      ? 'Shell is running without OS-level isolation because AGEN_UNSAFE_SHELL=1.'
      : undefined,
    localMcpStdioEnabled
      ? 'Local stdio MCP processes are running without OS-level isolation because AGEN_UNSAFE_MCP_STDIO=1.'
      : 'Local stdio MCP processes are disabled until they are routed through the sandbox runner.',
    sandboxNetworkAccess === 'full'
      ? 'Sandboxed shell commands have full network access because AGEN_UNSAFE_SANDBOX_NETWORK=1.'
      : undefined,
  ].filter((message): message is string => Boolean(message));
  const sandboxStatus: SandboxStatusWire = Object.freeze({
    backend: sandboxDetection.backend,
    isolation: sandboxDetection.backend === 'app-layer' ? 'application-only' : 'os',
    shellExecution: disableExecuteTools
      ? 'disabled'
      : sandboxDetection.backend === 'app-layer'
        ? 'unsafe-override'
        : 'isolated',
    localMcpStdio: localMcpStdioEnabled ? 'unsafe-override' : 'disabled',
    sandboxNetwork: sandboxNetworkAccess,
    ...(sandboxWarnings.length > 0 ? { warning: sandboxWarnings.join(' ') } : {}),
  });

  const protectedSandboxPaths = [
    ...sqliteFileSet(profileDbPath()),
    ...sqliteFileSet(dataDbPathFor(activeDataDir)),
  ];

  const tools = new ToolRegistry();
  registerBuiltinTools(tools, {
    disableExecuteTools,
    enableArtifacts:   releaseFeatures.artifacts,
    hasSubagentBridge: true,   // SubagentSpawner wired inside AgentEngine per turn
    hasMcpBridge:      true,   // mcpBridge adapter injected into toolCtx
    hasSkillBridge:    true,   // skillBridge adapter injected into toolCtx
    hasTaskStore:      true,
  });

  // Per-session command runner — memoised to avoid rebuilding SandboxConfig
  // on every turn (detectBackend + stat on bare-repo files is wasteful).
  const runnerCache = new Map<string, ICommandRunner>();
  const getCommandRunner = (sessionId: SessionId): ICommandRunner => {
    let runner = runnerCache.get(sessionId);
    if (runner) return runner;
    const s = session.getSession(sessionId);
    runner = new CommandRunner({
      workspaceRoot: s.workspaceRoot || process.cwd(),
      sessionId,
      permission,
      protectedPaths: protectedSandboxPaths,
      networkAccess:  sandboxNetworkAccess,
    });
    runnerCache.set(sessionId, runner);
    return runner;
  };

  const invalidateSessionRuntime = (sessionId: SessionId): void => {
    // Session Tool 状态继续保留，工作区变化不会让已读文件历史失效。
    // workspace-scoped. Only the runner bakes workspaceRoot in.
    runnerCache.delete(sessionId);
  };

  const removeSessionRuntime = (sessionId: SessionId): void => {
    // 会话删除专用: runner + context stores 全清(B-026)。
    // 与 invalidateSessionRuntime 不同——那个是 workspace 变更,
    // 文件状态历史还有用; 会话已删除时这些历史就是垃圾。
    runnerCache.delete(sessionId);
    sessionToolStoresCache.delete(sessionId);
  };

  // ── Session 文件状态与工具结果存储 ─────────────────────────────────────────
  // 新结果与音频、Artifact 使用同一正式 Session 根，永久删除 Session 时可由
  // removeSessionDir 一次清理；旧隐藏目录仅交给 Cleaner 做兼容回收。
  const sessionsDir = nodePath.join(activeDataDir, 'sessions');
  const legacyToolResultSessionsDir = nodePath.join(activeDataDir, '.ema-agent', 'sessions');
  const sessionToolStoresCache = new Map<string, {
    fileStateStore:  SessionFileStateStore;
    toolResultStore: ToolResultStore;
  }>();
  const getSessionToolStores = (sessionId: SessionId) => {
    let stores = sessionToolStoresCache.get(sessionId);
    if (stores) return stores;
    stores = {
      fileStateStore:  new SessionFileStateStore(),
      toolResultStore: new ToolResultStore(
        nodePath.join(sessionsDir, sessionId, 'tool-results'),
      ),
    };
    sessionToolStoresCache.set(sessionId, stores);
    return stores;
  };
  const toolResultCleaner = new ToolResultCleaner([
    sessionsDir,
    legacyToolResultSessionsDir,
  ]);
  const agentRunMessages = new AgentRunMessagesRepo(dataDb.sqlite);
  const agentRunStore = new AgentRunStore(new AgentRunsRepo(dataDb.sqlite));
  const taskStore = new TaskStore(new TasksRepo(dataDb.sqlite));
  const toolExecutionJournal = new ToolExecutionJournal(
    new ToolExecutionsRepo(dataDb.sqlite),
  );
  const interruptedTools = toolExecutionJournal.recoverInterrupted();
  const fileWriteRecovery = cleanupInterruptedFileWriteTemps(interruptedTools);
  if (interruptedTools.length > 0) {
    const unknownCount = interruptedTools.filter(
      execution => execution.status === 'outcome_unknown',
    ).length;
    console.warn(
      `[tool-execution] recovered ${interruptedTools.length} interrupted calls; `
      + `${unknownCount} may have produced side effects`,
    );
  }
  if (fileWriteRecovery.failed.length > 0) {
    console.warn(
      `[FileWriteTool] failed to remove ${fileWriteRecovery.failed.length} interrupted temporary files`,
    );
  }
  if (fileWriteRecovery.removed.length > 0) {
    console.info(
      `[FileWriteTool] removed ${fileWriteRecovery.removed.length} interrupted temporary files`,
    );
  }

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

  // ── Artifacts ───────────────────────────────────────────────────────────────
  // Per-session: {dataDir}/sessions/{sessionId}/artifacts/{id}. Collocated
  // with audio/scratchpad so removeSessionDir cleans everything together.
  const artifactStore = new ArtifactStore(
    new ArtifactRepo(dataDb.sqlite),
    nodePath.join(activeDataDir, 'sessions'),
    session,
  );

  // ── Attachments ─────────────────────────────────────────────────────────────
  const attachmentStore = new AttachmentStore(new AttachmentRepo(dataDb.sqlite), session);

  // ── Session detail (stats + notes) — used by /api/sessions/:id/dashboard ──
  const sessionStats = new SessionStatsRepo(dataDb.sqlite);
  const storageStats = new DataDirStatsRepo(dataDb.sqlite);
  const sessionNotes = new SessionNotesRepo(dataDb.sqlite);
  const sessionBackup = new SessionBackupFacade({
    activeDataDir,
    artifactsEnabled: releaseFeatures.artifacts,
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
        artifacts: releaseFeatures.artifacts ? artifactStore.listForExport(id) : [],
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
  // Adapter: expose McpRegistry as IMcpClientBridge for mcp_call tool injection.
  const mcpBridge: IMcpClientBridge = {
    call: (server, tool, args) => mcpRegistry.callTool(server, tool, args),
  };

  // ── Marketplace(多源聚合底座,MCP/Skill 共用)──────────────────────────────
  // 纯底座:adapter 注册表 + 通用源 store。各业务包(MCP/Skill)实现自己的 adapter
  // + seed,wiring 时注册。kind 不约束,未来 integration(QQ/微信/邮箱)零改底座接入。
  const marketRegistry    = new MarketRegistry();
  const marketSourceStore = new MarketSourceStore(new MarketSourcesRepo(profileDb.sqlite));
  marketRegistry.registerAdapter(new McpMarketAdapter());
  marketRegistry.registerAdapter(new SkillMarketAdapter());
  // startup 幂等 seed builtin 源(已存在则跳过,不覆盖用户的启停/排序)
  try {
    marketSourceStore.ensureSeeds([...MCP_SEEDS, ...SKILL_SEEDS]);
  } catch (err) {
    console.warn('[marketplace] seed failed:', err);
  }

  // ── Skills ───────────────────────────────────────────────────────────────────
  // File-backed: SKILL.md files live under the profile dir (cross-dataDir,
  // mirrors where profile.db lives). The SQL index in profile.db is a cache.
  const skillsUserRoot = nodePath.join(os.homedir(), '.ema-agent', 'skills');
  const skillStore     = new SkillStore(new SkillsRepo(profileDb.sqlite), [
    // builtin (read-only) root could be prepended here once skills ship with the app.
    { path: skillsUserRoot, source: 'user' },
  ]);
  // Reconcile the index against disk on startup (fire-and-forget, like kb.init).
  void skillStore.scanAndReconcile().catch((err) => console.warn('[skill] reconcile failed:', err));
  const skillRunner    = new SkillRunner(skillStore);
  const skillInstaller = new SkillInstaller(skillStore);
  // Adapter: expose the SkillRunner as ISkillRunner for the skill_call tool.
  // 懒读正文并返回能力限制；Agent 负责应用限制，Skill 包不能直接修改权限。
  const skillBridge: ISkillRunner = {
    run: async (skillName, args) => {
      const activation = await skillRunner.activate(skillName, args);
      return {
        content: activation.content,
        allowedToolPatterns: activation.allowedTools,
      };
    },
  };

  // ── Knowledge base ───────────────────────────────────────────────────────────
  const resolveIngestModels = (): Partial<IngestOptions> => {
    const kbModels = (settingsRepo.get('kb.models') as
      { embed?: { providerConfigId: string; model: string } } | undefined) ?? {};
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
    const kbModels = (settingsRepo.get('kb.models') as {
      embed?:  { providerConfigId: string; model: string };
      rerank?: { providerConfigId: string; model: string };
    } | undefined) ?? {};
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

  // Fire-and-forget: pull the models.dev catalog (context windows + capabilities).
  // On failure the catalog stays empty and lookups fall through to the DB / 0.
  void modelCatalog.refresh().then((ok) => {
    if (ok) console.info(`[catalog] models.dev loaded (${modelCatalog.size} models)`);
    else console.warn('[catalog] models.dev refresh failed; context/capability lookups degraded');
  });

  return {
    profileDb, dataDb, activeDataDir, credentials, fileAccess, sandboxStatus,
    hooks, session, sessionBackup,
    llm, embed, rerank, narrative, modelCatalog, modelCapabilities,
    card, emotion,
    tts, audioArchive, stt, vision, providerRuntime,
    permission, permissionPrompts, askUserRegistry, tools, buildAskForTurn, getCommandRunner,
    invalidateSessionRuntime, removeSessionRuntime,
    getSessionToolStores, toolResultCleaner, agentRunStore, taskStore,
    toolExecutionJournal, agentRunMessages,
    memory, contextCompactor,
    systemBus,
    providers, settings: settingsRepo,
    modelBindings, providerLlmModels, providerEmbedModels,
    providerRerankModels, providerTtsModels, providerSttModels, providerVisionModels,
    artifactStore, attachmentStore, sessionStats, storageStats, sessionNotes,
    mcpRegistry, mcpBridge,
    marketRegistry, marketSourceStore,
    skillStore, skillRunner, skillInstaller, skillBridge,
    kb, kbSearch,
    releaseFeatures,
  };
}

// ── Re-exports for routes that import directly from this module ───────────────
export { buildLlmProviderConfig }   from './providers/llm.js';
export { buildEmbedProviderConfig } from './providers/embed.js';
export { buildRerankProviderConfig } from './providers/rerank.js';
