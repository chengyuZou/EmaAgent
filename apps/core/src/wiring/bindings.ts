import type { Database } from '@ema-agent/storage';
import {
  ModelBindingsRepo,
  ProvidersRepo,
  SessionsRepo,
  SettingsRepo,
  MemoryNodesRepo, MemoryEdgesRepo, MemoryLazyUpdatesRepo,
  MemoryItemsRepo, SessionNotesRepo, BackgroundTasksRepo, PendingFragmentsRepo,
  ArtifactRepo,
  type ProviderConfigRow,
} from '@ema-agent/storage';
import { ArtifactStore } from '@ema-agent/artifact';
import { McpRegistry, McpServerStore }           from '@ema-agent/mcp';
import { SkillStore, SkillRunner, SkillInstaller } from '@ema-agent/skill';
import { McpServersRepo, SkillsRepo }              from '@ema-agent/storage';
import * as nodePath from 'node:path';
import { HookBus }       from '@ema-agent/hook';
import { createTraceSink } from './diagnostic-sink.js';
import { LlmRouter }     from '@ema-agent/llm';
import type { ProviderConfig } from '@ema-agent/llm';
import { EbdRouter }     from '@ema-agent/ebd-client';
import type {
  EmbedProviderConfig, RerankProviderConfig,
} from '@ema-agent/ebd-client';
import { NarrativeClient } from '@ema-agent/narrative-client';
import { CharacterCardStore } from '@ema-agent/character-card';
import { TtsClient, FsAudioArchive, type AudioArchive } from '@ema-agent/tts';
import { SttClient } from '@ema-agent/stt';
import { buildTtsClient } from './tts.js';
import { buildSttClient } from './stt.js';
import { sessionAudioDirFor } from '../storage-locations/index.js';
import { SessionStore }   from '@ema-agent/session';
import { EmotionEngine }  from '@ema-agent/emotion';
import {
  getProviderDefinition,
  isLlmProtocol, isEmbedProtocol, isRerankProtocol,
  resolveProtocols, resolveBaseUrl,
  type ProtocolFamily,
} from '@ema-agent/contracts';
import { PermissionEngine } from '@ema-agent/permission';
import type { AskPermissionFn } from '@ema-agent/permission';
import { PermissionPromptRegistry } from '../permissions/registry.js';
import { AskUserRegistry } from '../ask-user/registry.js';
import type { EmaStreamEvent } from '@ema-agent/contracts';
import { ToolRegistry } from '@ema-agent/tool';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import { detectBackend }        from '@ema-agent/sandbox';
import { MemoryPlanner } from '@ema-agent/memory';
import { CommandRunner } from '@ema-agent/sandbox';
import type { ICommandRunner } from '@ema-agent/tool';
import type { SessionId } from '@ema-agent/contracts';
import {
  AgentFileStateStore, AgentToolResultStore, ToolResultCleaner,
} from '@ema-agent/agent-context';
import { resolveBridgeUrl } from './bridge.js';
import { SystemEventBus } from '../sse/system-bus.js';

// ── App-wide bindings (Façade set passed everywhere) ─────────────────────────

/**
 * The complete dependency surface for all routes / orchestrator / engines.
 *
 * Kept flat — sub-bundles were considered but would force a refactor of every
 * route handler that already reads `bindings.session`, `bindings.llm`, etc.
 * Twelve fields is still readable; we revisit when it crosses ~16.
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

  hooks:         HookBus;
  session:       SessionStore;

  // AI clients
  llm:           LlmRouter;
  ebd:           EbdRouter;
  narrative:     NarrativeClient;

  // Per-card runtime
  card:          CharacterCardStore;
  emotion:       EmotionEngine;

  // TTS façade — synthesizes assistant text. Voice identity always reads
  // from the active card; provider/model/voiceId reads from model_bindings
  // rows tts_chat / tts_narrative / tts_agent. Fallback voice lives in
  // settings.tts.fallback. STT lives in a separate package (apps/stt).
  tts:           TtsClient;

  // Audio storage — per-segment write + per-turn merge. Lives under
  // {activeDataDir}/audio. The TtsCoordinator pipes synthesized chunks here
  // so a completed turn can be played back later via /api/turns/:id/audio.
  audioArchive:  AudioArchive;

  // STT façade — converts user audio → text. One binding (no per-mode split
  // for STT in V1). Reads model_bindings.stt + corresponding provider config.
  stt:           SttClient;

  // Agent stack
  permission:        PermissionEngine;
  permissionPrompts: PermissionPromptRegistry;
  /** In-memory registry for pending ask_user prompts — the tool awaits a
   *  Promise; this registry resolves it when the frontend posts answers. */
  askUserRegistry:   AskUserRegistry;
  tools:             ToolRegistry;
  /**
   * Per-turn factory that yields an askPermission callback wired to the
   * provided SSE emit. Passed into AgentEngine.deps.buildAsk.
   */
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    string;
    emit:      (ev: EmaStreamEvent) => void;
  }) => AskPermissionFn;
  /**
   * Per-session sandbox runner. Workspace root differs across sessions so we
   * cache one runner per sessionId — the factory builds + memoises on demand.
   */
  getCommandRunner: (sessionId: SessionId) => ICommandRunner;

  /**
   * Per-session file-state + tool-result store factory. Creates + memoises on
   * first call per sessionId. Used by AgentEngine and the memory hooks (recentFiles).
   */
  getContextStores: (sessionId: SessionId) => {
    fileStateStore:  AgentFileStateStore;
    toolResultStore: AgentToolResultStore;
  };
  /** Sweeps offloaded tool-result files — called by background tick. */
  toolResultCleaner: ToolResultCleaner;

  // Memory subsystem
  memory:        MemoryPlanner;

  // System-wide pub/sub for cross-turn events (memory pipeline, background
  // tasks, card switches, provider health). Backs GET /api/system/events.
  systemBus:     SystemEventBus;

  // Repos kept on the binding for route convenience
  modelBindings:   ModelBindingsRepo;
  artifactStore:   ArtifactStore;
  mcpRegistry:     McpRegistry;
  skillStore:      SkillStore;
  skillRunner:     SkillRunner;
  skillInstaller:  SkillInstaller;
}

// ── Provider config builders (exported — providers route reuses them) ───────

export function buildLlmProviderConfig(row: ProviderConfigRow): ProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('llm')) return null;

  // config_json may carry a user-selected protocol (when the definition offers
  // multiple choices). Fall back to the first declared protocol.
  const extra    = JSON.parse(row.config_json) as Record<string, unknown>;
  const choices  = resolveProtocols(def.protocols.llm);
  const stored   = typeof extra['protocol'] === 'string' ? extra['protocol'] : undefined;
  // Cast to ProtocolFamily so the type guard can narrow to LlmProtocol.
  const protocol = (stored && choices.includes(stored as never) ? stored : choices[0]) as ProtocolFamily | undefined;
  if (!isLlmProtocol(protocol)) return null;
  // After guard, protocol: LlmProtocol

  const needsKey = def.requiresCredentials !== false;
  if (needsKey && !row.api_key_plain) return null;

  const rawCw = extra['contextWindow'];
  return {
    id:            row.id,
    protocol,
    apiKey:        row.api_key_plain ?? '',
    baseUrl:       row.base_url ?? resolveBaseUrl(def, protocol),
    defaultModel:  typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
    // User-configured context window for custom/Ollama/OpenRouter models.
    // Takes precedence over ModelCatalog in register-hooks.ts.
    contextWindow: typeof rawCw === 'number' && rawCw > 0 ? rawCw : undefined,
  };
}

export function buildEmbedProviderConfig(row: ProviderConfigRow): EmbedProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('embed')) return null;

  const protocol = resolveProtocols(def.protocols.embed)[0] as ProtocolFamily | undefined;
  if (!isEmbedProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    dim:          typeof extra['dim'] === 'number' ? extra['dim'] : 1024,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

export function buildRerankProviderConfig(row: ProviderConfigRow): RerankProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('rerank')) return null;

  const protocol = resolveProtocols(def.protocols.rerank)[0] as ProtocolFamily | undefined;
  if (!isRerankProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

// ── Provider list loaders (private — used by buildBindings) ──────────────────

function loadLlmConfigs(db: Database): ProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: ProviderConfig[] = [];
  for (const row of repo.listByCapability('llm')) {
    const cfg = buildLlmProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

function loadEmbedConfigs(db: Database): EmbedProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: EmbedProviderConfig[] = [];
  for (const row of repo.listByCapability('embed')) {
    const cfg = buildEmbedProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

function loadRerankConfigs(db: Database): RerankProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: RerankProviderConfig[] = [];
  for (const row of repo.listByCapability('rerank')) {
    const cfg = buildRerankProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Build bindings (does NOT register hooks/emitters — that's a later step) ──

/**
 * Construct every Façade. Pure data assembly: no hook registration, no
 * subscriber wiring, no side effects beyond DB reads and Façade construction.
 *
 * The `wire(db)` entry point in ./index.ts orchestrates:
 *   buildBindings(db)   ← this function
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
  // Sessions / turns / messages live in dataDb.
  const hooks   = new HookBus({
    traceSink:     createTraceSink(),   // ring buffer + console, SSE layer added by orchestrator
    warnAnonymous: process.env['NODE_ENV'] !== 'production',
  });
  const session = new SessionStore({ db: dataDb });

  // ── AI clients (provider configs live in profileDb) ────────────────────────
  const llm = new LlmRouter(loadLlmConfigs(profileDb));
  const ebd = new EbdRouter(loadEmbedConfigs(profileDb), loadRerankConfigs(profileDb));

  const narrative = new NarrativeClient({
    baseUrl:   resolveBridgeUrl(),
    secret:    process.env['EMA_SHARED_SECRET'],
    timeoutMs: 60_000,
  });

  // ── Character + emotion (character cards live in profileDb) ────────────────
  const card = new CharacterCardStore({ db: profileDb });
  card.ensureSeed();
  const emotion = new EmotionEngine({ vocabulary: card.current().emotionVocabulary });

  // ── TTS façade (depends on card + profileDb) ───────────────────────────────
  // Built once; provider configs / bindings can be hot-reloaded later via
  // routes (provider POST/PUT and model-bindings PUT), at which point we
  // either rebuild or expose upsert methods on TtsClient (deferred to 6B-3).
  const tts = buildTtsClient({ profileDb });

  // ── Audio archive ───────────────────────────────────────────────────────────
  // TODO(wiring): FsAudioArchive should be per-session, using
  //   sessionAudioDirFor(activeDataDir, sessionId)
  // so files land under sessions/<sessionId>/audio/.
  // For now we keep a shared root; the session-scoped path helpers are in place
  // for when the orchestrator is wired up with per-session archives.
  const audioArchive = new FsAudioArchive(
    nodePath.join(activeDataDir, 'audio'),
  );

  // ── STT façade ─────────────────────────────────────────────────────────────
  const stt = buildSttClient({ profileDb });

  // ── Repos ───────────────────────────────────────────────────────────────────
  const modelBindings = new ModelBindingsRepo(profileDb.sqlite);
  const sessionsRepo  = new SessionsRepo(dataDb.sqlite);

  // ── Permission + tools ─────────────────────────────────────────────────────
  //
  // settings.permission.askTimeoutMs lives in profileDb (app-level setting).
  const settingsRepo = new SettingsRepo(profileDb.sqlite);
  const storedTimeout = settingsRepo.get('permission.askTimeoutMs');
  const permissionPrompts = new PermissionPromptRegistry(
    typeof storedTimeout === 'number' ? storedTimeout : 120_000,
  );

  // Dev mode: 5 s timeout so a missing frontend doesn't stall the turn for 2 min.
  // Production keeps 120 s so the user has time to read and answer.
  const askUserTimeoutMs = process.env['NODE_ENV'] === 'development' ? 5_000 : 120_000;
  const askUserRegistry = new AskUserRegistry(askUserTimeoutMs);

  // Always 'ask' — every write/execute tool surfaces a confirmation dialog.
  // AGEN_PERMISSION_BYPASS=1 lets automated tests or power users skip prompts.
  const permissionMode = process.env['AGEN_PERMISSION_BYPASS'] === '1' ? 'bypass' : 'ask';
  const permission = new PermissionEngine({
    mode: permissionMode,
    // Read-only tools are always allowed — no side effects, no prompt fatigue.
    // Write/execute tools remain gated by `permissionMode`.
    // Always allow read-only tools — no side effects, no prompt fatigue.
    // Tool names must match the registered tool name strings exactly.
    rules: [
      { tool: 'fs_read', action: 'allow', scope: 'global' },
      { tool: 'glob',    action: 'allow', scope: 'global' },
      { tool: 'grep',    action: 'allow', scope: 'global' },
    ],
    ask: async () => ({ action: 'deny', reason: 'no per-turn ask wired' }),
  });

  const buildAskForTurn = (args: {
    sessionId: string;
    turnId:    string;
    emit:      (ev: EmaStreamEvent) => void;
  }): AskPermissionFn => {
    return async (prompt) => {
      const { promptId, promise } = permissionPrompts.create({
        sessionId: args.sessionId,
        turnId:    args.turnId,
      });
      args.emit({
        type:     'permission_required',
        promptId,
        tool:     prompt.toolName,
        args:     prompt.input,
        hint:     prompt.gateReason ?? '',
      });
      const response = await promise;
      args.emit({
        type:     'permission_resolved',
        promptId,
        decision: response.action === 'allow'    ? 'allow'
                : response.action === 'allow_session' ? 'allow'
                : response.action === 'always_allow'  ? 'allow'
                : 'deny',
      });
      return response;
    };
  };

  // Detect sandbox capability once — cached for the process lifetime.
  // On Windows native without WSL2+bubblewrap, backend = 'app-layer' (no
  // physical OS isolation). Exposing shell tools without a real sandbox is a
  // security boundary failure, so we omit them unless the operator opts in
  // via AGEN_UNSAFE_SHELL=1 (dev/test use only).
  const sandboxDetection = detectBackend();
  const disableExecuteTools =
    sandboxDetection.backend === 'app-layer' &&
    process.env['AGEN_UNSAFE_SHELL'] !== '1';

  const tools = new ToolRegistry();
  registerBuiltinTools(tools, { disableExecuteTools });

  // ── Sandbox: per-session command runner cache ──────────────────────────────
  //
  // workspaceRoot differs per session, so each session gets its own runner.
  // We memoise to avoid rebuilding the SandboxConfig on every turn (re-running
  // detectBackend() and re-stat'ing bare-repo files would be wasteful).
  const runnerCache = new Map<string, ICommandRunner>();
  const getCommandRunner = (sessionId: SessionId): ICommandRunner => {
    let runner = runnerCache.get(sessionId);
    if (runner) return runner;
    const s = session.getSession(sessionId);
    const workspaceRoot = s.workspaceRoots[0] ?? process.cwd();
    runner = new CommandRunner({
      workspaceRoot,
      additionalWorkingDirs: s.workspaceRoots.slice(1),
      sessionId,
      permission,
    });
    runnerCache.set(sessionId, runner);
    return runner;
  };

  // ── Agent context stores (per-session file state + tool result offload) ────
  //
  // Mirrors the getCommandRunner cache pattern: each session gets its own pair
  // of stores. sessionsDir layout: {activeDataDir}/.ema-agent/sessions/{sessionId}/
  const sessionsDir = nodePath.join(activeDataDir, '.ema-agent', 'sessions');
  const contextStoresCache = new Map<string, {
    fileStateStore:  AgentFileStateStore;
    toolResultStore: AgentToolResultStore;
  }>();
  const getContextStores = (sessionId: SessionId) => {
    let stores = contextStoresCache.get(sessionId);
    if (stores) return stores;
    const toolResultsDir = nodePath.join(sessionsDir, sessionId, 'tool-results');
    stores = {
      fileStateStore:  new AgentFileStateStore(),
      toolResultStore: new AgentToolResultStore(toolResultsDir),
    };
    contextStoresCache.set(sessionId, stores);
    return stores;
  };
  const toolResultCleaner = new ToolResultCleaner(sessionsDir);

  // ── System event bus (cross-turn observability) ────────────────────────────
  // Built before memory so we can wire memory's `emit` into it.
  const systemBus = new SystemEventBus();

  // ── Memory (all tables live in dataDb) ─────────────────────────────────────
  // MemoryDeps.db is used as a context handle in a few places that need the
  // underlying sqlite handle — we hand over dataDb, since that's where every
  // memory table actually lives.
  const memory = new MemoryPlanner({
    db:              dataDb,
    session,
    llm,
    ebd,
    narrative,
    modelBindings,
    nodes:            new MemoryNodesRepo(dataDb.sqlite),
    edges:            new MemoryEdgesRepo(dataDb.sqlite),
    lazyUpdates:      new MemoryLazyUpdatesRepo(dataDb.sqlite),
    items:            new MemoryItemsRepo(dataDb.sqlite),
    sessionNotes:     new SessionNotesRepo(dataDb.sqlite),
    backgroundTasks:  new BackgroundTasksRepo(dataDb.sqlite),
    pendingFragments: new PendingFragmentsRepo(dataDb.sqlite),
    sessions:        sessionsRepo,
    emit:            (ev) => systemBus.emit(ev),
  });

  // ── Artifact store ─────────────────────────────────────────────────────────
  const artifactRepo  = new ArtifactRepo(dataDb.sqlite);
  const artifactsDir  = nodePath.join(activeDataDir, '.ema-agent', 'artifacts');
  const artifactStore = new ArtifactStore(artifactRepo, artifactsDir);

  // ── MCP registry ────────────────────────────────────────────────────────────
  const mcpServersRepo = new McpServersRepo(profileDb.sqlite);
  const mcpServerStore = new McpServerStore(mcpServersRepo);
  // Gate stdio MCP server spawning through PermissionEngine.
  // HTTP/SSE servers connect freely (no local subprocess spawned).
  const mcpStdioGate = async (serverName: string, command: string): Promise<boolean> => {
    const outcome = await permission.gate(
      'mcp_stdio_connect',
      { serverName, command },
      { riskLevel: 'high', accessType: 'execute' },
      { workspaceRoot: process.cwd() },
    );
    return outcome.granted;
  };

  const mcpRegistry = new McpRegistry(mcpServerStore, tools, mcpStdioGate);

  // ── Skill ────────────────────────────────────────────────────────────────────
  const skillsRepo     = new SkillsRepo(profileDb.sqlite);
  const skillStore     = new SkillStore(skillsRepo);
  const skillRunner    = new SkillRunner(skillStore, hooks);
  const skillInstaller = new SkillInstaller(skillStore);

  return {
    profileDb, dataDb, activeDataDir,
    hooks, session,
    llm, ebd, narrative,
    card, emotion,
    tts, audioArchive, stt,
    permission, permissionPrompts, askUserRegistry, tools, buildAskForTurn, getCommandRunner,
    getContextStores, toolResultCleaner,
    memory,
    systemBus,
    modelBindings,
    artifactStore,
    mcpRegistry,
    skillStore,
    skillRunner,
    skillInstaller,
  };
}
