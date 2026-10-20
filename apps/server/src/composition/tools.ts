import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createWebRequests, registerBuiltinTools, type WebRequests } from '@ema-agent/builtin-tools';
import {
  McpMarketService,
  McpMarketStore,
  McpLocalCommandEnvironment,
  OfficialRegistryAdapter,
  McpRegistry,
  McpServerStore,
  type McpEvent,
} from '@ema-agent/mcp';
import {
  CommandRunner,
  detectBackend,
  probeBash,
  sandboxNetworkSetting,
  type BackendKind,
  type SandboxNetwork,
} from '@ema-agent/sandbox';
import type { SettingsStore } from '@ema-agent/settings';
import {
  createMarketInstaller,
  createMarketService,
  createSkillRegistry,
  SkillStore,
  type MarketInstaller,
  type MarketService,
  type SkillRegistry,
} from '@ema-agent/skills';
import {
  McpMarketEntriesRepo,
  McpServersRepo,
  ToolExecutionsRepo,
  BackgroundProcessesRepo,
  type Database,
} from '@ema-agent/storage';
import {
  BackgroundProcess,
  FileStateCache,
  ToolExecutionState,
  ToolRegistry,
  ToolResultCleaner,
  ToolResultStore,
  readBackgroundProcessSettings,
  type BackgroundProcessEvent,
  type BackgroundProcessNotifiableStatus,
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

/** 目标目录不存在才复制种子, 已存在时保留磁盘内容, 不覆盖用户修改. */
function installBuiltinSkills(sourceRoot: string, targetRoot: string): void {
  if (!fs.existsSync(sourceRoot) || fs.existsSync(targetRoot)) return;
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });
}

export interface ToolsDeps {
  readonly assertSessionWorkAllowed: (sessionId: string) => void;
  readonly profileDb: Database;
  readonly dataDb: Database;
  readonly activeDataDir: string;
  readonly settings: SettingsStore;
  readonly emitBackgroundEvent: (event: BackgroundProcessEvent) => void;
  readonly onBackgroundCompletion: (
    sessionId: string,
    backgroundProcessId: string,
    status: BackgroundProcessNotifiableStatus,
  ) => void;
  readonly emitMcpEvent: (event: McpEvent) => void;
}

export interface ToolsComposition {
  readonly webRequests: WebRequests;
  readonly registry: ToolRegistry;
  readonly backgroundProcesses: BackgroundProcess;
  readonly toolExecutionState: ToolExecutionState;
  readonly toolResultCleaner: ToolResultCleaner;
  readonly mcp: McpRegistry;
  readonly mcpMarket: McpMarketService;
  readonly mcpEnvironment: McpLocalCommandEnvironment;
  readonly skills: SkillRegistry;
  readonly skillStore: SkillStore;
  /** 技能市场聚合服务与安装器(SkillHub/ClawHub 真实 Adapter). */
  readonly skillMarket: MarketService;
  readonly skillMarketInstaller: MarketInstaller;
  /** 状态查询读取当前网络设置, 不复用某次 Turn 的值. */
  getSandboxStatus(): SandboxStatus;
  /** 等待 Bash 探测后, 使用本 Turn 的 cwd 与 Project folders 构造命令运行器. */
  getCommandRunner(
    cwd: string,
    workspaceRoots: readonly string[],
  ): Promise<CommandRunner | undefined>;
  /** Session 级外置工具结果存储(按 Session 缓存目录句柄). */
  getSessionToolResultStore(sessionId: string): ToolResultStore;
  getSessionFileStateCache(sessionId: string): FileStateCache;
  clearFileStateCaches(): void;
  /**
   * Session 删除时清理其工具侧进程内状态:停掉该 Session 的后台进程, 
   * 释放文件状态与外置工具结果存储缓存.
   */
  discardSessionToolState(sessionId: string): Promise<void>;
}

export interface SandboxStatus {
  readonly backend: BackendKind;
  /** Bash 的启用策略, 不代表 Bash 探测结果或 PowerShell 的隔离能力. */
  readonly bashMode: 'sandboxed' | 'disabled' | 'unsandboxed';
  readonly networkAccess: SandboxNetwork;
  readonly warning?: string;
  readonly warningDetails?: string;
}

/** NODE_ENV=production 时拒绝 Bash 沙箱绕过开关, 避免安装版以开发配置执行命令. */
function readUnsafeOverrides(env: NodeJS.ProcessEnv): { shell: boolean } {
  const overrides = {
    shell: env.AGEN_UNSAFE_SHELL === '1',
  };
  if (env.NODE_ENV === 'production' && overrides.shell) {
    throw new Error('正式构建禁止使用 AGEN_UNSAFE_* 沙箱绕过开关');
  }
  return overrides;
}

export function openTools(deps: ToolsDeps): ToolsComposition {
  const { profileDb, dataDb, activeDataDir, settings } = deps;

  const detection = detectBackend();
  const overrides = readUnsafeOverrides(process.env);
  const disableExecuteTools = detection.backend === 'unisolated' && !overrides.shell;
  const getSandboxStatus = (): SandboxStatus => {
    const network = settings.get(sandboxNetworkSetting);
    const warnings = [
      detection.degradeReason,
      detection.backend === 'unisolated' && overrides.shell
        ? 'Bash 未使用操作系统沙箱(AGEN_UNSAFE_SHELL=1).'
        : undefined,
      network === 'full' && !disableExecuteTools
        ? 'Bash 命令允许完全网络访问.'
        : undefined,
    ].filter((message): message is string => Boolean(message));
    let bashMode: SandboxStatus['bashMode'] = 'sandboxed';
    if (disableExecuteTools) {
      bashMode = 'disabled';
    } else if (detection.backend === 'unisolated') {
      bashMode = 'unsandboxed';
    }
    return Object.freeze({
      backend: detection.backend,
      bashMode,
      networkAccess: network,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      ...(detection.degradeDetails ? { warningDetails: detection.degradeDetails } : {}),
    });
  };
  // 提前查找 Bash, Turn 准备阶段仍会等待同一次探测, 不依赖它恰好已经完成.
  if (!disableExecuteTools) void probeBash();

  // 有隔离能力的后端禁止命令直接读写这些 SQLite 文件, 避免绕过 Server 修改数据库.
  const forbiddenPaths = Object.freeze([
    ...sqliteFileSet(profileDbPath()),
    ...sqliteFileSet(dataDbPathFor(activeDataDir)),
  ]);
  const getCommandRunner = async (
    cwd: string,
    workspaceRoots: readonly string[],
  ): Promise<CommandRunner | undefined> => {
    if (disableExecuteTools) return undefined;
    const bash = await probeBash();
    if (!bash.available) return undefined;
    const shell = bash.source === 'wsl'
      ? { kind: 'wsl' as const }
      : { kind: 'native' as const, path: bash.path };
    const temporaryWritePaths = process.platform === 'darwin'
      ? [os.tmpdir(), '/tmp', '/private/tmp']
      : [os.tmpdir()];
    return new CommandRunner({
      cwd,
      writablePaths: [...workspaceRoots, ...temporaryWritePaths],
      forbiddenPaths,
      networkAccess: settings.get(sandboxNetworkSetting),
    }, shell);
  };

  const registry = new ToolRegistry();
  registerBuiltinTools(registry, { disableExecuteTools });

  const backgroundProcesses = new BackgroundProcess({
    assertSessionWorkAllowed: deps.assertSessionWorkAllowed,
    store: new BackgroundProcessesRepo(dataDb.sqlite),
    outputPath: (sessionId, processId) =>
      backgroundProcessOutputDirFor(activeDataDir, sessionId, processId),
    resolveOutputLocation: relativeDirectory => ({
      absoluteDirectory: path.join(activeDataDir, relativeDirectory),
      relativeDirectory,
    }),
    settings: () => readBackgroundProcessSettings(settings),
    emit: event => deps.emitBackgroundEvent(event),
    onCompletion: (sessionId, backgroundProcessId, status) => {
      deps.onBackgroundCompletion(sessionId, backgroundProcessId, status);
    },
  });
  const toolExecutionState = new ToolExecutionState(new ToolExecutionsRepo(dataDb.sqlite));

  const sessionsDir = path.join(activeDataDir, 'sessions');
  const resultStores = new Map<string, ToolResultStore>();
  const fileStateCaches = new Map<string, FileStateCache>();
  const getSessionFileStateCache = (sessionId: string): FileStateCache => {
    const cached = fileStateCaches.get(sessionId);
    if (cached) return cached;
    const cache = new FileStateCache();
    fileStateCaches.set(sessionId, cache);
    return cache;
  };
  const getSessionToolResultStore = (sessionId: string): ToolResultStore => {
    const cached = resultStores.get(sessionId);
    if (cached) return cached;
    const store = new ToolResultStore(path.join(sessionsDir, sessionId, 'tool-results'));
    resultStores.set(sessionId, store);
    return store;
  };

  // 先用已保存的工具目录注册入口, 再后台连接启用的 MCP Server.
  const mcpServers = new McpServerStore(
    new McpServersRepo(profileDb.sqlite),
    event => deps.emitMcpEvent(event),
  );
  const mcp = new McpRegistry(
    mcpServers,
    registry,
    () => deps.emitMcpEvent({ type: 'mcp_connection_changed' }),
  );
  mcp.primeFromCache();
  mcp.connectEnabledInBackground();
  const mcpMarket = new McpMarketService(
    new McpMarketStore(new McpMarketEntriesRepo(profileDb.sqlite)),
    [new OfficialRegistryAdapter()],
    mcp,
    source => deps.emitMcpEvent({ type: 'mcp_market_changed', source }),
  );
  const mcpEnvironment = new McpLocalCommandEnvironment();

  // 内置技能由宿主打包资源提供;开发期从仓库种子目录铺到 profile,目标已存在即不动.
  installBuiltinSkills(bundledSkillsSource(), builtinSkillsDir());
  const skillUserRoot = path.join(profileDir(), 'skills');
  const skillStore = new SkillStore(profileDb, skillUserRoot, builtinSkillsDir());
  const skills = createSkillRegistry({ store: skillStore });
  // builtin+user 启动时装载一次;project 技能按工作区在 list() 时现扫.
  // 装载前先清掉安装中途死掉留下的孤儿 staging 目录.
  // 首次 Turn 准备时的 list() 会等待这次装载, 无需在此阻塞装配.
  void skillStore.sweepOrphanStaging()
    .then(() => skills.refreshCore())
    .catch(error => {
      console.warn('[skills] 启动装载失败:', error);
    });
  const skillMarket = createMarketService({ userRoot: skillUserRoot });
  const skillMarketInstaller = createMarketInstaller({
    store: skillStore,
    userRoot: skillUserRoot,
    market: skillMarket,
  });

  return {
    webRequests: createWebRequests(),
    registry,
    backgroundProcesses,
    toolExecutionState,
    toolResultCleaner: new ToolResultCleaner(sessionsDir),
    mcp,
    mcpMarket,
    mcpEnvironment,
    skills,
    skillStore,
    skillMarket,
    skillMarketInstaller,
    getSandboxStatus,
    getCommandRunner,
    getSessionToolResultStore,
    getSessionFileStateCache,
    clearFileStateCaches() {
      for (const cache of fileStateCaches.values()) {
        cache.clear();
      }
      fileStateCaches.clear();
    },
    async discardSessionToolState(sessionId) {
      await backgroundProcesses.discardSession(sessionId);
      resultStores.delete(sessionId);
      fileStateCaches.get(sessionId)?.clear();
      fileStateCaches.delete(sessionId);
    },
  };
}
