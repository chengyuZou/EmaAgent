import type { Database } from '@ema-agent/storage';
import {
  ModelBindingsRepo,
  ProvidersRepo,
  SessionsRepo,
  SettingsRepo,
  MemoryNodesRepo, MemoryEdgesRepo, MemoryLazyUpdatesRepo,
  MemoryItemsRepo, SessionNotesRepo, BackgroundTasksRepo,
  type ProviderConfigRow,
} from '@ema-agent/storage';
import { HookBus }       from '@ema-agent/hook';
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
import { audioDirFor } from '../storage-locations/index.js';
import { SessionStore }   from '@ema-agent/session';
import { EmotionEngine }  from '@ema-agent/emotion';
import {
  getProviderDefinition,
  isLlmProtocol, isEmbedProtocol, isRerankProtocol,
} from '@ema-agent/contracts';
import { PermissionEngine } from '@ema-agent/permission';
import type { AskPermissionFn } from '@ema-agent/permission';
import { PermissionPromptRegistry } from '../permissions/registry.js';
import type { EmaStreamEvent } from '@ema-agent/contracts';
import { ToolRegistry } from '@ema-agent/tool';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import { MemoryPlanner } from '@ema-agent/memory';
import { CommandRunner } from '@ema-agent/sandbox';
import type { ICommandRunner } from '@ema-agent/tool';
import type { SessionId } from '@ema-agent/contracts';
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

  // Memory subsystem
  memory:        MemoryPlanner;

  // System-wide pub/sub for cross-turn events (memory pipeline, background
  // tasks, card switches, provider health). Backs GET /api/system/events.
  systemBus:     SystemEventBus;

  // Repos kept on the binding for route convenience
  modelBindings: ModelBindingsRepo;
}

// ── Provider config builders (exported — providers route reuses them) ───────

export function buildLlmProviderConfig(row: ProviderConfigRow): ProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('llm')) return null;

  const protocol = def.protocols.llm;
  if (!isLlmProtocol(protocol)) return null;

  const needsKey = def.requiresCredentials !== false;
  if (needsKey && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    provider:     protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

export function buildEmbedProviderConfig(row: ProviderConfigRow): EmbedProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('embed')) return null;

  const protocol = def.protocols.embed;
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

  const protocol = def.protocols.rerank;
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
  const hooks   = new HookBus();
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
  const tts = buildTtsClient({ profileDb, card });

  // ── Audio archive (lives under {activeDataDir}/audio) ──────────────────────
  const audioArchive = new FsAudioArchive(audioDirFor(activeDataDir));

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

  const permission = new PermissionEngine({
    mode:  'ask',                       // default to safe; user can flip in settings
    rules: [],                          // V1 starts empty; rules accrete as user grants
    ask:   async () => ({ action: 'deny', reason: 'no per-turn ask wired' }),
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

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

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
    nodes:           new MemoryNodesRepo(dataDb.sqlite),
    edges:           new MemoryEdgesRepo(dataDb.sqlite),
    lazyUpdates:     new MemoryLazyUpdatesRepo(dataDb.sqlite),
    items:           new MemoryItemsRepo(dataDb.sqlite),
    sessionNotes:    new SessionNotesRepo(dataDb.sqlite),
    backgroundTasks: new BackgroundTasksRepo(dataDb.sqlite),
    sessions:        sessionsRepo,
    emit:            (ev) => systemBus.emit(ev),
  });

  return {
    profileDb, dataDb, activeDataDir,
    hooks, session,
    llm, ebd, narrative,
    card, emotion,
    tts, audioArchive, stt,
    permission, permissionPrompts, tools, buildAskForTurn, getCommandRunner,
    memory,
    systemBus,
    modelBindings,
  };
}
