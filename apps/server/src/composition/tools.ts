// 工具一族：沙箱策略、ToolRegistry、内置/MCP/Skill 注册表、后台进程、执行状态与结果存储。
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerBuiltinTools } from '@ema-agent/builtin-tools';
import {
  McpRegistry,
  McpRegistrySourceStore,
  McpServerStore,
  type McpStdioLaunchIntent,
} from '@ema-agent/mcp';
import {
  CommandRunner,
  detectBackend,
  probeBash,
  type BackendKind,
} from '@ema-agent/sandbox';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  createSkillRegistry,
  createSkillStore,
  SkillSiteStore,
  type SkillRegistry,
  type SkillStore,
} from '@ema-agent/skills';
import {
  McpRegistrySourcesRepo,
  McpServersRepo,
  SkillsRepo,
  SkillSitesRepo,
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
  bundledSkillsDir,
  dataDbPathFor,
  profileDir,
  profileDbPath,
  sqliteFileSet,
} from '../platform/paths.js';
import type { McpStdioApprovalRequest } from '../sse/eventHub.js';

/** 系统接口与设置页展示的沙箱状态；宿主组合事实，不是 Sandbox 执行器自己的类型。 */
export interface SandboxStatusWire {
  readonly kind: BackendKind;
  readonly isolation: 'os' | 'application-only';
  readonly shellExecution: 'isolated' | 'disabled' | 'unsafe-override';
  readonly sandboxNetwork: 'none' | 'full';
  readonly localMcpStdio: 'isolated' | 'disabled' | 'unsafe-override';
  readonly warning?: string;
}

/** 批准请求线上形状归 sse/eventHub 的 AppEvent 域；这里只负责通道机制。 */

const STDIO_APPROVAL_TIMEOUT_MS = 60_000;

/**
 * 非 Turn 的用户批准通道（CLAUDE.md §9：stdio 拉起必须过门禁，批准完整启动意图）。
 * ask 挂起直到路由回答或超时拒绝；与 Turn 内的 SessionInteractionQueue 不同域——
 * MCP 启动是应用级管理动作，不进 Session FIFO。
 */
export class McpStdioApprovalChannel {
  private readonly pending = new Map<string, {
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly emitRequest: (request: McpStdioApprovalRequest) => void) {}

  ask(intent: McpStdioLaunchIntent): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const request: McpStdioApprovalRequest = {
      requestId,
      operation: intent.operation,
      serverName: intent.serverName,
      command: intent.command,
      args: [...intent.args],
      ...(intent.cwd ? { cwd: intent.cwd } : {}),
      environmentKeys: Object.keys(intent.environment ?? {}).sort(),
      createdAt: Date.now(),
    };
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, STDIO_APPROVAL_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      this.emitRequest(request);
    });
  }

  /** 路由回答；未知或已超时的 requestId 返回 false。 */
  answer(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(approved);
    return true;
  }
}

export interface ToolsDeps {
  readonly profileDb: Database;
  readonly dataDb: Database;
  readonly activeDataDir: string;
  readonly session: SessionStore;
  readonly settings: SettingsStore;
  readonly emitBackgroundEvent: (event: BackgroundProcessEvent) => void;
  readonly emitStdioApproval: (request: McpStdioApprovalRequest) => void;
}

export interface ToolsComposition {
  readonly registry: ToolRegistry;
  readonly backgroundProcesses: BackgroundProcess;
  readonly toolExecutionState: ToolExecutionState;
  readonly toolResultCleaner: ToolResultCleaner;
  readonly mcp: McpRegistry;
  readonly mcpServers: McpServerStore;
  readonly mcpSources: McpRegistrySourceStore;
  readonly skills: SkillRegistry;
  readonly skillStore: SkillStore;
  /** 技能市场站点注册表与安装落位根目录（staging 与 rename 同卷的约束来源）。 */
  readonly skillSites: SkillSiteStore;
  readonly skillUserRoot: string;
  readonly stdioApprovals: McpStdioApprovalChannel;
  readonly sandboxStatus: SandboxStatusWire;
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
function readUnsafeOverrides(env: NodeJS.ProcessEnv): { shell: boolean; localMcpStdio: boolean; network: boolean } {
  const overrides = {
    shell: env.AGEN_UNSAFE_SHELL === '1',
    localMcpStdio: env.AGEN_UNSAFE_MCP_STDIO === '1',
    network: env.AGEN_UNSAFE_SANDBOX_NETWORK === '1',
  };
  if (env.NODE_ENV === 'production' && (overrides.shell || overrides.localMcpStdio || overrides.network)) {
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
    overrides.localMcpStdio
      ? '本地 stdio MCP 进程正在以无 OS 隔离运行（AGEN_UNSAFE_MCP_STDIO=1）。'
      : undefined,
    overrides.network
      ? '沙箱内 Shell 命令具有完全网络访问（AGEN_UNSAFE_SANDBOX_NETWORK=1）。'
      : undefined,
  ].filter((message): message is string => Boolean(message));
  const sandboxStatus: SandboxStatusWire = Object.freeze({
    kind: detection.backend,
    isolation: detection.backend === 'unisolated' ? 'application-only' : 'os',
    shellExecution: disableExecuteTools
      ? 'disabled'
      : detection.backend === 'unisolated'
        ? 'unsafe-override'
        : 'isolated',
    localMcpStdio: overrides.localMcpStdio ? 'unsafe-override' : 'disabled',
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

  // ── MCP：缓存预填（不拉起进程）+ stdio 批准通道 ─────────────────────────────
  const mcpServers = new McpServerStore(new McpServersRepo(profileDb.sqlite));
  const stdioApprovals = new McpStdioApprovalChannel(deps.emitStdioApproval);
  const mcp = new McpRegistry(
    mcpServers,
    registry,
    intent => stdioApprovals.ask(intent),
    overrides.localMcpStdio,
  );
  mcp.primeFromCache();
  const mcpSources = new McpRegistrySourceStore(new McpRegistrySourcesRepo(profileDb.sqlite));
  mcpSources.ensureOfficialSeed();

  // ── Skill：目录是事实源，SQL 只是索引与溯源 ─────────────────────────────────
  const skillUserRoot = path.join(profileDir(), 'skills');
  const skillStore = createSkillStore({
    repo: new SkillsRepo(profileDb.sqlite),
    userRoot: skillUserRoot,
  });
  const skills = createSkillRegistry({
    userRoot: skillUserRoot,
    builtinRoot: builtinSkillsDir(),
    bundledSkillsSource: bundledSkillsDir(),
    store: skillStore,
  });
  const skillSites = new SkillSiteStore(new SkillSitesRepo(profileDb.sqlite));

  return {
    registry,
    backgroundProcesses,
    toolExecutionState,
    toolResultCleaner: new ToolResultCleaner(sessionsDir),
    mcp,
    mcpServers,
    mcpSources,
    skills,
    skillStore,
    skillSites,
    skillUserRoot,
    stdioApprovals,
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
