import type { Database } from '@ema-agent/storage';
import {
  ModelBindingsRepo,
  SettingsRepo,
  MemoryNodesRepo, MemoryEdgesRepo, MemoryLazyUpdatesRepo,
  MemoryItemsRepo, SessionNotesRepo, MemoryTasksRepo, PendingFragmentsRepo,
  ArtifactRepo, AttachmentRepo,
  MemorySessionStateRepo,
  ProviderLlmModelsRepo, ProviderEmbedModelsRepo,
  ProviderRerankModelsRepo, ProviderTtsModelsRepo, ProviderSttModelsRepo,
  McpServersRepo, SkillsRepo,
} from '@ema-agent/storage';
import { AttachmentStore } from '@ema-agent/attachment';
import { ArtifactStore }                               from '@ema-agent/artifact';
import { McpRegistry, McpServerStore }                 from '@ema-agent/mcp';
import { SkillStore, SkillRunner, SkillInstaller }     from '@ema-agent/skill';
import * as nodePath from 'node:path';
import { HookBus }       from '@ema-agent/hook';
import { createTraceSink } from './diagnostic-sink.js';
import { LlmRouter }     from '@ema-agent/llm';
import { EbdRouter }     from '@ema-agent/ebd-client';
import { NarrativeClient } from '@ema-agent/narrative-client';
import { CharacterCardStore } from '@ema-agent/character-card';
import { TtsClient, FsAudioArchive, type AudioArchive } from '@ema-agent/tts';
import { SttClient }     from '@ema-agent/stt';
import { buildTtsClient } from './providers/tts.js';
import { buildSttClient } from './providers/stt.js';
import { lookupEmbedDim } from '@ema-agent/token';
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
import type { EmaStreamEvent }      from '@ema-agent/contracts';
import { ToolRegistry }        from '@ema-agent/tool';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import { detectBackend, CommandRunner } from '@ema-agent/sandbox';
import type { ICommandRunner }     from '@ema-agent/tool';
import type { SessionId }          from '@ema-agent/contracts';
import {
  AgentFileStateStore, AgentToolResultStore, ToolResultCleaner,
} from '@ema-agent/agent-context';
import { MemoryPlanner } from '@ema-agent/memory';
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

  // Memory subsystem
  memory: MemoryPlanner;

  // System-wide pub/sub for cross-turn events (memory pipeline, background
  // tasks, card switches, provider health). Backs GET /api/system/events.
  systemBus: SystemEventBus;

  // Repos kept on the binding for route convenience
  modelBindings:        ModelBindingsRepo;
  providerLlmModels:    ProviderLlmModelsRepo;
  providerEmbedModels:  ProviderEmbedModelsRepo;
  providerRerankModels: ProviderRerankModelsRepo;
  providerTtsModels:    ProviderTtsModelsRepo;
  providerSttModels:    ProviderSttModelsRepo;
  artifactStore:    ArtifactStore;
  attachmentStore:  AttachmentStore;
  mcpRegistry:      McpRegistry;
  skillStore:     SkillStore;
  skillRunner:    SkillRunner;
  skillInstaller: SkillInstaller;
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
  const providerLlmModels    = new ProviderLlmModelsRepo(profileDb.sqlite);
  const providerEmbedModels  = new ProviderEmbedModelsRepo(profileDb.sqlite);
  const providerRerankModels = new ProviderRerankModelsRepo(profileDb.sqlite);
  const providerTtsModels    = new ProviderTtsModelsRepo(profileDb.sqlite);
  const providerSttModels    = new ProviderSttModelsRepo(profileDb.sqlite);

  // ── AI clients (provider configs live in profileDb) ────────────────────────
  const llm = new LlmRouter(loadLlmConfigs(profileDb));
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
  const tts = buildTtsClient({ profileDb });
  const stt = buildSttClient({ profileDb });

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
  registerBuiltinTools(tools, { disableExecuteTools });

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
  const toolResultCleaner = new ToolResultCleaner(sessionsDir);

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
    getEmbedDim:      (model) => providerEmbedModels.dimFor(model) ?? lookupEmbedDim(model) ?? 0,
    emit:             (ev) => systemBus.emit(ev),
  });

  // ── Artifacts ───────────────────────────────────────────────────────────────
  const artifactStore = new ArtifactStore(
    new ArtifactRepo(dataDb.sqlite),
    nodePath.join(activeDataDir, '.ema-agent', 'artifacts'),
  );

  // ── Attachments ─────────────────────────────────────────────────────────────
  const attachmentStore = new AttachmentStore(new AttachmentRepo(dataDb.sqlite));

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

  // ── Skills ───────────────────────────────────────────────────────────────────
  const skillStore     = new SkillStore(new SkillsRepo(profileDb.sqlite));
  const skillRunner    = new SkillRunner(skillStore, hooks);
  const skillInstaller = new SkillInstaller(skillStore);

  return {
    profileDb, dataDb, activeDataDir,
    hooks, session,
    llm, ebd, narrative,
    card, emotion,
    tts, audioArchive, stt,
    permission, permissionPrompts, askUserRegistry, tools, buildAskForTurn, getCommandRunner,
    invalidateSessionRuntime,
    getContextStores, toolResultCleaner,
    memory,
    systemBus,
    modelBindings, providerLlmModels, providerEmbedModels,
    providerRerankModels, providerTtsModels, providerSttModels,
    artifactStore, attachmentStore,
    mcpRegistry,
    skillStore, skillRunner, skillInstaller,
  };
}

// ── Re-exports for routes that import directly from this module ───────────────
export { buildLlmProviderConfig }   from './providers/llm.js';
export { buildEmbedProviderConfig } from './providers/embed.js';
export { buildRerankProviderConfig } from './providers/rerank.js';
