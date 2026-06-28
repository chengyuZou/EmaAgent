import type { Database } from '@ema-agent/storage';
import {
  ModelBindingsRepo,
  ProvidersRepo,
  SettingsRepo,
  MemoryNodesRepo, MemoryEdgesRepo, MemoryLazyUpdatesRepo,
  MemoryItemsRepo, SessionNotesRepo, MemoryTasksRepo, PendingFragmentsRepo,
  ArtifactRepo, AttachmentRepo,
  MemorySessionStateRepo,
  ProviderLlmModelsRepo, ProviderEmbedModelsRepo,
  ProviderRerankModelsRepo, ProviderTtsModelsRepo, ProviderSttModelsRepo, ProviderVisionModelsRepo,
  McpServersRepo, SkillsRepo,
  AgentTasksRepo, AgentTaskMessagesRepo,
  SessionStatsRepo, DataDirStatsRepo,
} from '@ema-agent/storage';
import { AttachmentStore } from '@ema-agent/attachment';
import { ArtifactStore }                               from '@ema-agent/artifact';
import { McpRegistry, McpServerStore }                 from '@ema-agent/mcp';
import { SkillStore, SkillRunner, SkillInstaller }     from '@ema-agent/skill';
import * as nodePath from 'node:path';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { HookBus }       from '@ema-agent/hook';
import { createTraceSink } from './diagnostic-sink.js';
import { LlmRouter, ModelsDevCatalog } from '@ema-agent/llm';
import { EbdRouter }     from '@ema-agent/ebd-client';
import { NarrativeClient } from '@ema-agent/narrative-client';
import { CharacterCardStore } from '@ema-agent/character-card';
import { TtsClient, FsAudioArchive, type AudioArchive } from '@ema-agent/tts';
import { SttClient }     from '@ema-agent/stt';
import { buildTtsClient } from './providers/tts.js';
import { buildSttClient } from './providers/stt.js';
import { buildVisionRouter, asKbVisionAdapter } from './providers/vision.js';
import { VisionRouter } from '@ema-agent/vision';
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
import type { EmaStreamEvent, KbAssetScope, SessionId, KbSearchResult } from '@ema-agent/contracts';
import { ToolRegistry }        from '@ema-agent/tools';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import { detectBackend, CommandRunner } from '@ema-agent/sandbox';
import type { ICommandRunner, IMcpClientBridge, ISkillRunner } from '@ema-agent/tools';
import {
  AgentFileStateStore, AgentToolResultStore, ToolResultCleaner,
} from '@ema-agent/agent-context';
import { AgentTaskStore } from '@ema-agent/agent-task';
import { MemoryPlanner } from '@ema-agent/memory';
import {
  KbManager,
} from '@ema-agent/knowledge-base';
import type { IngestOptions } from '@ema-agent/knowledge-base';
import {
  KbActivationsRepo, KbRegistryRepo,
} from '@ema-agent/storage';
import { resolveBridgeUrl } from './bridge.js';
import { SystemEventBus }  from '../sse/system-bus.js';

// ── App-wide bindings (Façade set passed everywhere) ─────────────────────────

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

  hooks:   HookBus;
  session: SessionStore;

  // AI clients
  llm:       LlmRouter;
  ebd:       EbdRouter;
  /** models.dev LLM/Vision catalog — context window + capabilities by modelsDevId. */
  modelCatalog: ModelsDevCatalog;
  narrative: NarrativeClient;

  // Per-card runtime
  card:    CharacterCardStore;
  emotion: EmotionEngine;

  // TTS façade — synthesizes assistant text. Voice identity always reads from
  // the active card; provider/model reads from the single `tts` model_bindings
  // row (one binding for all modes).
  tts:         TtsClient;
  // Audio archive — per-segment write + per-turn merge, under {activeDataDir}/audio.
  audioArchive: AudioArchive;
  // STT façade — converts user audio → text (single binding in V1).
  stt:          SttClient;
  // Vision façade — image understanding; used by KB ingest (OCR fallback).
  vision:       VisionRouter;

  // Agent stack
  permission:        PermissionEngine;
  permissionPrompts: PermissionPromptRegistry;
  /** In-memory registry for pending ask_user prompts. */
  askUserRegistry:   AskUserRegistry;
  tools:             ToolRegistry;
  /** Per-turn factory that yields an askPermission callback wired to SSE emit. */
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    string;
    emit:      (ev: EmaStreamEvent) => void;
  }) => AskPermissionFn;
  /** Per-session sandbox runner — memoised on first call per sessionId. */
  getCommandRunner: (sessionId: SessionId) => ICommandRunner;
  /**
   * Drop a session's cached CommandRunner so the next getCommandRunner()
   * rebuilds it from current state. MUST be called whenever workspaceRoots
   * change — the runner bakes the roots into its sandbox config at
   * construction, so a stale cache means commands keep running (and the
   * sandbox keeps permitting writes) in the OLD workspace.
   */
  invalidateSessionRuntime: (sessionId: SessionId) => void;
  /** Per-session file-state + tool-result store — memoised on first call. */
  getContextStores: (sessionId: SessionId) => {
    fileStateStore:  AgentFileStateStore;
    toolResultStore: AgentToolResultStore;
  };
  /** Sweeps offloaded tool-result files — called by background tick. */
  toolResultCleaner: ToolResultCleaner;
  /** Cross-session agent task registry — used for crash recovery and task visibility. */
  taskStore:          AgentTaskStore;
  /** Direct repo access for the SSE fan-out to write subagent transcript messages. */
  agentTaskMessages:  AgentTaskMessagesRepo;

  // Memory subsystem
  memory: MemoryPlanner;

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
}

// ── Build bindings ────────────────────────────────────────────────────────────

/**
 * Construct every Façade. Pure data assembly: no hook registration, no
 * subscriber wiring, no side effects beyond DB reads and Façade construction.
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
}

export function buildBindings(args: BuildBindingsArgs): AppBindings {
  const { profileDb, dataDb, activeDataDir } = args;

  // ── Core infra ──────────────────────────────────────────────────────────────
  const hooks   = new HookBus({
    traceSink:     createTraceSink(),   // ring buffer + console; SSE layer added by orchestrator
    warnAnonymous: process.env['NODE_ENV'] !== 'production',
  });
  const session = new SessionStore({ db: dataDb });

  // ── Per-provider model pools (profileDb) ────────────────────────────────────
  const providers            = new ProvidersRepo(profileDb.sqlite);
  const providerLlmModels    = new ProviderLlmModelsRepo(profileDb.sqlite);
  const providerEmbedModels  = new ProviderEmbedModelsRepo(profileDb.sqlite);
  const providerRerankModels = new ProviderRerankModelsRepo(profileDb.sqlite);
  const providerTtsModels    = new ProviderTtsModelsRepo(profileDb.sqlite);
  const providerSttModels    = new ProviderSttModelsRepo(profileDb.sqlite);
  const providerVisionModels = new ProviderVisionModelsRepo(profileDb.sqlite);

  // ── AI clients (provider configs live in profileDb) ────────────────────────
  // models.dev catalog: load bundled snapshot first (instant, offline-safe),
  // then refresh from network in the background. Consumers get catalog data
  // immediately from the snapshot; the refresh updates it silently.
  // Must be created before LlmRouter so it can be passed in for reasoning lookup.
  const modelCatalog = new ModelsDevCatalog();
  try {
    const snapshotPath = nodePath.join(import.meta.dirname!, 'models-dev-snapshot.json');
    modelCatalog.loadFromJson(JSON.parse(readFileSync(snapshotPath, 'utf8')));
    console.info(`[catalog] loaded bundled snapshot (${modelCatalog.size} models)`);
  } catch {
    console.warn('[catalog] no bundled snapshot found, will rely on network refresh');
  }
  const llm = new LlmRouter(loadLlmConfigs(profileDb), undefined, modelCatalog);
  const ebd = new EbdRouter(loadEmbedConfigs(profileDb), loadRerankConfigs(profileDb));

  const narrative = new NarrativeClient({
    baseUrl:   resolveBridgeUrl(),
    secret:    process.env['EMA_SHARED_SECRET'],
    timeoutMs: 60_000,
  });

  // ── Character + emotion ─────────────────────────────────────────────────────
  const card = new CharacterCardStore({ db: profileDb });
  card.ensureSeed();
  const emotion = new EmotionEngine({ vocabulary: card.current().emotionVocabulary });

  // ── TTS / STT ───────────────────────────────────────────────────────────────
  const tts    = buildTtsClient({ profileDb });
  const stt    = buildSttClient({ profileDb });
  const vision = buildVisionRouter(profileDb);

  // ── Audio archive ───────────────────────────────────────────────────────────
  // TODO(wiring): should be per-session → sessionAudioDirFor(activeDataDir, sessionId).
  // Shared root is fine for V1 (single-user, one active session at a time).
  const audioArchive = new FsAudioArchive(
    nodePath.join(activeDataDir, 'audio'),
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
  const disableExecuteTools =
    sandboxDetection.backend === 'app-layer' &&
    process.env['AGEN_UNSAFE_SHELL'] !== '1';

  const tools = new ToolRegistry();
  registerBuiltinTools(tools, {
    disableExecuteTools,
    hasSubagentBridge: true,   // SubagentSpawner wired inside AgentEngine per turn
    hasMcpBridge:      true,   // mcpBridge adapter injected into toolCtx
    hasSkillBridge:    true,   // skillBridge adapter injected into toolCtx
  });

  // Per-session command runner — memoised to avoid rebuilding SandboxConfig
  // on every turn (detectBackend + stat on bare-repo files is wasteful).
  const runnerCache = new Map<string, ICommandRunner>();
  const getCommandRunner = (sessionId: SessionId): ICommandRunner => {
    let runner = runnerCache.get(sessionId);
    if (runner) return runner;
    const s = session.getSession(sessionId);
    runner = new CommandRunner({
      workspaceRoots: s.workspaceRoots.length > 0 ? s.workspaceRoots : [process.cwd()],
      sessionId,
      permission,
    });
    runnerCache.set(sessionId, runner);
    return runner;
  };

  const invalidateSessionRuntime = (sessionId: SessionId): void => {
    // contextStores intentionally survive — file-state history is not
    // workspace-scoped. Only the runner bakes workspaceRoots in.
    runnerCache.delete(sessionId);
  };

  // ── Agent context stores ────────────────────────────────────────────────────
  const sessionsDir = nodePath.join(activeDataDir, '.ema-agent', 'sessions');
  const contextStoresCache = new Map<string, {
    fileStateStore:  AgentFileStateStore;
    toolResultStore: AgentToolResultStore;
  }>();
  const getContextStores = (sessionId: SessionId) => {
    let stores = contextStoresCache.get(sessionId);
    if (stores) return stores;
    stores = {
      fileStateStore:  new AgentFileStateStore(),
      toolResultStore: new AgentToolResultStore(
        nodePath.join(sessionsDir, sessionId, 'tool-results'),
      ),
    };
    contextStoresCache.set(sessionId, stores);
    return stores;
  };
  const toolResultCleaner    = new ToolResultCleaner(sessionsDir);
  const agentTaskMessages    = new AgentTaskMessagesRepo(dataDb.sqlite);
  const taskStore            = new AgentTaskStore(new AgentTasksRepo(dataDb.sqlite));

  // ── System event bus ────────────────────────────────────────────────────────
  const systemBus = new SystemEventBus();

  // ── Memory ──────────────────────────────────────────────────────────────────
  const memory = new MemoryPlanner({
    session,
    llm,
    ebd,
    modelBindings,
    nodes:            new MemoryNodesRepo(profileDb.sqlite),
    edges:            new MemoryEdgesRepo(profileDb.sqlite),
    lazyUpdates:      new MemoryLazyUpdatesRepo(profileDb.sqlite),
    items:            new MemoryItemsRepo(profileDb.sqlite),
    sessionNotes:     new SessionNotesRepo(dataDb.sqlite),
    memoryTasks:      new MemoryTasksRepo(dataDb.sqlite),
    pendingFragments:   new PendingFragmentsRepo(dataDb.sqlite),
    memorySessionState: new MemorySessionStateRepo(dataDb.sqlite),
    // dim is probed at enable time and stored on provider_embed_models (dim_source='probed').
    getEmbedDim:      (model) => providerEmbedModels.dimFor(model) ?? 0,
    emit:             (ev) => systemBus.emit(ev),
    hookBus:          hooks,
  });

  // ── Artifacts ───────────────────────────────────────────────────────────────
  const artifactStore = new ArtifactStore(
    new ArtifactRepo(dataDb.sqlite),
    nodePath.join(activeDataDir, '.ema-agent', 'artifacts'),
  );

  // ── Attachments ─────────────────────────────────────────────────────────────
  const attachmentStore = new AttachmentStore(new AttachmentRepo(dataDb.sqlite));

  // ── Session detail (stats + notes) — used by /api/sessions/:id/dashboard ──
  const sessionStats = new SessionStatsRepo(dataDb.sqlite);
  const storageStats = new DataDirStatsRepo(dataDb.sqlite);
  const sessionNotes = new SessionNotesRepo(dataDb.sqlite);

  // ── MCP registry ────────────────────────────────────────────────────────────
  const mcpStdioGate = async (serverName: string, command: string): Promise<boolean> => {
    const outcome = await permission.gate(
      'mcp_stdio_connect',
      { serverName, command },
      { riskLevel: 'high', accessType: 'execute' },
      { workspaceRoots: [process.cwd()] },
    );
    return outcome.granted;
  };
  const mcpRegistry = new McpRegistry(
    new McpServerStore(new McpServersRepo(profileDb.sqlite)),
    tools,
    mcpStdioGate,
  );
  // Adapter: expose McpRegistry as IMcpClientBridge for mcp_call tool injection.
  const mcpBridge: IMcpClientBridge = {
    call: (server, tool, args) => mcpRegistry.callTool(server, tool, args),
  };

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
  const skillRunner    = new SkillRunner(skillStore, hooks);
  const skillInstaller = new SkillInstaller(skillStore);
  // Adapter: expose the SkillRunner as ISkillRunner for the skill_call tool.
  // Reads the skill body lazily from disk and substitutes $ARGUMENTS — the
  // calling LLM receives the instructions as the tool result and acts on them.
  const skillBridge: ISkillRunner = {
    run: async (skillName, args) => skillRunner.render(skillName, args),
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
    ebdRouter:            ebd,
    visionAdapter:        asKbVisionAdapter(vision),
    resolveIngestOptions: resolveIngestModels,
    concurrency:          3,
  });

  // Bridge KbManager's aggregated event bus → systemBus SSE.
  // kbId is now injected by KbManager.openEntry; forward it on every event type.
  kb.events.on((e) => {
    const kbId = e.kbId ?? '';
    if (e.kind === 'complete') { systemBus.emit({ type: 'kb_ingest_completed', kbId, assetId: e.assetId }); return; }
    if (e.kind === 'error')    { systemBus.emit({ type: 'kb_ingest_failed', kbId, assetId: e.assetId, error: e.error ?? 'unknown' }); return; }
    const base: Record<string, number> = { validate: 0.05, parse: 0.25, chunk: 0.45, embed: 0.5 };
    const progress = e.kind === 'embed' ? 0.5 + 0.5 * (e.progress ?? 0) : (base[e.kind] ?? 0);
    systemBus.emit({ type: 'kb_ingest_progress', kbId, assetId: e.assetId, stage: e.kind, progress });
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
    profileDb, dataDb, activeDataDir,
    hooks, session,
    llm, ebd, narrative, modelCatalog,
    card, emotion,
    tts, audioArchive, stt, vision,
    permission, permissionPrompts, askUserRegistry, tools, buildAskForTurn, getCommandRunner,
    invalidateSessionRuntime,
    getContextStores, toolResultCleaner, taskStore, agentTaskMessages,
    memory,
    systemBus,
    providers, settings: settingsRepo,
    modelBindings, providerLlmModels, providerEmbedModels,
    providerRerankModels, providerTtsModels, providerSttModels, providerVisionModels,
    artifactStore, attachmentStore, sessionStats, storageStats, sessionNotes,
    mcpRegistry, mcpBridge,
    skillStore, skillRunner, skillInstaller, skillBridge,
    kb, kbSearch,
  };
}

// ── Re-exports for routes that import directly from this module ───────────────
export { buildLlmProviderConfig }   from './providers/llm.js';
export { buildEmbedProviderConfig } from './providers/embed.js';
export { buildRerankProviderConfig } from './providers/rerank.js';
