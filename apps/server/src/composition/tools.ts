// 工具一族：沙箱策略、ToolRegistry、内置/MCP/Skill 注册表、后台进程、执行状态与结果存储。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { registerBuiltinTools } from '@ema-agent/builtin-tools';
import {
  McpMarketService,
  McpMarketStore,
  McpLocalCommandEnvironment,
  OfficialRegistryAdapter,
  McpRegistry,
  McpServerStore,
  type McpConnection,
  type McpMarketSource,
} from '@ema-agent/mcp';
import {
  CommandRunner,
  detectBackend,
  probeBash,
  type SandboxStatus,
} from '@ema-agent/sandbox';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  createMarketInstaller,
  createMarketService,
  createSkillRegistry,
  createSkillStore,
  type MarketInstaller,
  type MarketService,
  type SkillRegistry,
  type SkillStore,
} from '@ema-agent/skills';
import {
  McpMarketEntriesRepo,
  McpServersRepo,
  SkillEnablementRepo,
  SkillsRepo,
  ToolExecutionsRepo,
  BackgroundProcessesRepo,
  type Database,
} from '@ema-agent/storage';
import {
  BackgroundProcess,
  ToolExecutionState,
  ToolRegistry,
  ToolResultCleaner,
  ToolResultStore,
  readBackgroundProcessSettings,
  type BackgroundProcessEvent,
} from '@ema-agent/tools';
import {
  backgroundProcessOutputDirFor,
  builtinSkillsDir,
  bundledSkillsSource,
  dataDbPathFor,
  profileDir,
  profileDbPath,
  sqliteFileSet,
} from '../platform/paths.js';

/** 内置技能铺设：目标目录不存在才整目录复制；已存在即不动（内置内容由宿主升级时整批替换）。 */
function installBuiltinSkills(sourceRoot: string, targetRoot: string): void {
  if (!fs.existsSync(sourceRoot) || fs.existsSync(targetRoot)) return;
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });
}

export interface ToolsDeps {
  readonly profileDb: Database;
  readonly dataDb: Database;
  readonly activeDataDir: string;
  readonly session: SessionStore;
  readonly settings: SettingsStore;
  readonly emitBackgroundEvent: (event: BackgroundProcessEvent) => void;
  readonly emitMcpConnection: (connection: McpConnection) => void;
  readonly emitMcpMarket: (source: McpMarketSource) => void;
}

export interface ToolsComposition {
  readonly registry: ToolRegistry;
  readonly backgroundProcesses: BackgroundProcess;
  readonly toolExecutionState: ToolExecutionState;
  readonly toolResultCleaner: ToolResultCleaner;
  readonly mcp: McpRegistry;
  readonly mcpServers: McpServerStore;
  readonly mcpMarket: McpMarketService;
  readonly mcpEnvironment: McpLocalCommandEnvironment;
  readonly skills: SkillRegistry;
  readonly skillStore: SkillStore;
  /** builtin/user 逐技能启停事实（skill_enablement 表）。 */
  readonly skillEnablement: SkillEnablementRepo;
  /** 技能市场聚合服务与安装器（SkillHub/ClawHub 真实 Adapter）。 */
  readonly skillMarket: MarketService;
  readonly skillMarketInstaller: MarketInstaller;
  readonly skillUserRoot: string;
  readonly sandboxStatus: SandboxStatus;
  /** 按 Session 缓存的命令运行器；workspaceRoot 变化后必须 invalidate。 */
  getCommandRunner(sessionId: string): CommandRunner | undefined;
  invalidateSessionRunner(sessionId: string): void;
  /** Session 级外置工具结果存储（按 Session 缓存目录句柄）。 */
  getSessionToolResultStore(sessionId: string): ToolResultStore;
  /**
   * Session 删除时清理其工具侧进程内状态：停掉该 Session 的后台进程、
   * 释放命令运行器缓存与外置工具结果存储缓存。
   */
  discardSessionToolState(sessionId: string): Promise<void>;
}

/** 不安全开关只服务本地开发；正式构建发现任一开关直接拒绝启动。 */
function readUnsafeOverrides(env: NodeJS.ProcessEnv): { shell: boolean; network: boolean } {
  const overrides = {
    shell: env.AGEN_UNSAFE_SHELL === '1',
    network: env.AGEN_UNSAFE_SANDBOX_NETWORK === '1',
  };
  if (env.NODE_ENV === 'production' && (overrides.shell || overrides.network)) {
    throw new Error('正式构建禁止使用 AGEN_UNSAFE_* 沙箱绕过开关');
  }
  return overrides;
}

export function openTools(deps: ToolsDeps): ToolsComposition {
  const { profileDb, dataDb, activeDataDir, session, settings } = deps;

  // ── 沙箱策略（本机能力探测 + 显式开发开关收敛） ──────────────────────────────
  const detection = detectBackend();
  const overrides = readUnsafeOverrides(process.env);
  const disableExecuteTools = detection.backend === 'unisolated' && !overrides.shell;
  const warnings = [
    detection.degradeReason,
    detection.backend === 'unisolated' && overrides.shell
      ? 'Shell 正在以无 OS 隔离运行（AGEN_UNSAFE_SHELL=1）。'
      : undefined,
    overrides.network
      ? '沙箱内 Shell 命令具有完全网络访问（AGEN_UNSAFE_SANDBOX_NETWORK=1）。'
      : undefined,
  ].filter((message): message is string => Boolean(message));
  const sandboxStatus: SandboxStatus = Object.freeze({
    kind: detection.backend,
    isolation: detection.backend === 'unisolated' ? 'application-only' : 'os',
    shellExecution: disableExecuteTools
      ? 'disabled'
      : detection.backend === 'unisolated'
        ? 'unsafe-override'
        : 'isolated',
    sandboxNetwork: overrides.network ? 'full' : 'none',
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  });
  // 启动预热 bash 探测：首个 Shell 命令到达时同步 peek 直接命中。
  void probeBash();

  // Sandbox 必须永远禁止读写 Profile/Data 的 SQLite 文件族。
  const forbiddenPaths = Object.freeze([
    ...sqliteFileSet(profileDbPath()),
    ...sqliteFileSet(dataDbPathFor(activeDataDir)),
  ]);
  const runners = new Map<string, CommandRunner>();
  const getCommandRunner = (sessionId: string): CommandRunner | undefined => {
    const cached = runners.get(sessionId);
    if (cached) return cached;
    const workspaceRoot = session.getSession(sessionId).workspaceRoot;
    if (!workspaceRoot) return undefined;
    const temporaryWritePaths = process.platform === 'darwin'
      ? [os.tmpdir(), '/tmp', '/private/tmp']
      : [os.tmpdir()];
    const runner = new CommandRunner({
      workspaceRoot,
      writablePaths: [workspaceRoot, ...temporaryWritePaths],
      forbiddenPaths,
      networkAccess: overrides.network ? 'full' : 'none',
    });
    runners.set(sessionId, runner);
    return runner;
  };

  // ── 工具注册表与内置目录 ────────────────────────────────────────────────────
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, { disableExecuteTools });

  // ── 后台进程、执行状态、结果存储 ─────────────────────────────────────────────
  const backgroundProcesses = new BackgroundProcess({
    store: new BackgroundProcessesRepo(dataDb.sqlite),
    outputPath: (sessionId, processId) =>
      backgroundProcessOutputDirFor(activeDataDir, sessionId, processId),
    resolveOutputLocation: relativeDirectory => ({
      absoluteDirectory: path.join(activeDataDir, relativeDirectory),
      relativeDirectory,
    }),
    settings: () => readBackgroundProcessSettings(settings),
    emit: event => deps.emitBackgroundEvent(event),
  });
  const toolExecutionState = new ToolExecutionState(new ToolExecutionsRepo(dataDb.sqlite));

  const sessionsDir = path.join(activeDataDir, 'sessions');
  const resultStores = new Map<string, ToolResultStore>();
  const getSessionToolResultStore = (sessionId: string): ToolResultStore => {
    const cached = resultStores.get(sessionId);
    if (cached) return cached;
    const store = new ToolResultStore(path.join(sessionsDir, sessionId, 'tool-results'));
    resultStores.set(sessionId, store);
    return store;
  };

  // ── MCP：缓存预填后并发连接启用项；市场缓存独立于已安装 Server。 ─────────────
  const mcpServers = new McpServerStore(new McpServersRepo(profileDb.sqlite));
  const mcp = new McpRegistry(
    mcpServers,
    registry,
    connection => deps.emitMcpConnection(connection),
  );
  mcp.primeFromCache();
  mcp.connectEnabledInBackground();
  const mcpMarket = new McpMarketService(
    new McpMarketStore(new McpMarketEntriesRepo(profileDb.sqlite)),
    [new OfficialRegistryAdapter()],
    mcp,
    source => deps.emitMcpMarket(source),
  );
  const mcpEnvironment = new McpLocalCommandEnvironment();

  // ── Skill：目录是事实源，SQL 只是索引与溯源 ─────────────────────────────────
  // 内置技能由宿主打包资源提供；开发期从仓库种子目录铺到 profile，目标已存在即不动。
  installBuiltinSkills(bundledSkillsSource(), builtinSkillsDir());
  const skillUserRoot = path.join(profileDir(), 'skills');
  const skillEnablement = new SkillEnablementRepo(profileDb.sqlite);
  const skillStore = createSkillStore({
    repo: new SkillsRepo(profileDb.sqlite),
    enablement: skillEnablement,
    userRoot: skillUserRoot,
  });
  const skills = createSkillRegistry({
    userRoot: skillUserRoot,
    builtinRoot: builtinSkillsDir(),
    store: skillStore,
  });
  // builtin+user 启动时装载一次；project 技能按工作区在 list() 时现扫。
  // 装载前先清掉安装中途死掉留下的孤儿 staging 目录。
  // 首根 Turn 的 list() 会等待这次装载，无需在此阻塞装配。
  void skillStore.sweepOrphanStaging()
    .then(() => skills.refreshCore())
    .catch(error => {
      console.warn('[skills] 启动装载失败（Skill 目录本轮为空）:', error);
    });
  const skillMarket = createMarketService({ userRoot: skillUserRoot });
  const skillMarketInstaller = createMarketInstaller({
    store: skillStore,
    userRoot: skillUserRoot,
    market: skillMarket,
  });

  return {
    registry,
    backgroundProcesses,
    toolExecutionState,
    toolResultCleaner: new ToolResultCleaner(sessionsDir),
    mcp,
    mcpServers,
    mcpMarket,
    mcpEnvironment,
    skills,
    skillStore,
    skillEnablement,
    skillMarket,
    skillMarketInstaller,
    skillUserRoot,
    sandboxStatus,
    getCommandRunner,
    invalidateSessionRunner: sessionId => { runners.delete(sessionId); },
    getSessionToolResultStore,
    async discardSessionToolState(sessionId) {
      await backgroundProcesses.discardSession(sessionId);
      runners.delete(sessionId);
      resultStores.delete(sessionId);
    },
  };
}
