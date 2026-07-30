// 装配本机沙箱状态，并按 Session 管理与工作区绑定的命令运行器。

import os from 'node:os';
import type { SessionId } from '@ema-agent/ids';
import type { SessionStore } from '@ema-agent/session';
import {
  CommandRunner,
  detectBackend,
  type CommandRunnerPort,
  type DetectResult,
  type SandboxStatusWire,
} from '@ema-agent/sandbox';
import {
  dataDbPathFor,
  profileDbPath,
  sqliteFileSet,
} from '../storage-locations/index.js';

interface SandboxUnsafeOverrides {
  readonly shell: boolean;
  readonly localMcpStdio: boolean;
  readonly network: boolean;
}

interface SandboxEnvironment {
  readonly NODE_ENV?: string;
  readonly AGEN_UNSAFE_SHELL?: string;
  readonly AGEN_UNSAFE_MCP_STDIO?: string;
  readonly AGEN_UNSAFE_SANDBOX_NETWORK?: string;
}

export interface SandboxRuntimePolicy {
  readonly status: SandboxStatusWire;
  readonly disableExecuteTools: boolean;
  readonly localMcpStdioEnabled: boolean;
  readonly networkAccess: 'none' | 'full';
}

/**
 * 把机器探测结果和显式开发开关收敛成一份安全策略。
 * app-layer 只能说明应用做了参数检查，不能伪装成系统级隔离。
 */
export function resolveSandboxRuntimePolicy(
  detection: DetectResult,
  overrides: SandboxUnsafeOverrides,
): SandboxRuntimePolicy {
  const disableExecuteTools =
    detection.backend === 'app-layer' && !overrides.shell;
  const localMcpStdioEnabled = overrides.localMcpStdio;
  const networkAccess = overrides.network ? 'full' as const : 'none' as const;
  const warnings = [
    detection.degradeReason,
    detection.backend === 'app-layer' && overrides.shell
      ? 'Shell is running without OS-level isolation because AGEN_UNSAFE_SHELL=1.'
      : undefined,
    localMcpStdioEnabled
      ? 'Local stdio MCP processes are running without OS-level isolation because AGEN_UNSAFE_MCP_STDIO=1.'
      : 'Local stdio MCP processes are disabled until they are routed through the sandbox runner.',
    networkAccess === 'full'
      ? 'Sandboxed shell commands have full network access because AGEN_UNSAFE_SANDBOX_NETWORK=1.'
      : undefined,
  ].filter((message): message is string => Boolean(message));

  return {
    disableExecuteTools,
    localMcpStdioEnabled,
    networkAccess,
    status: Object.freeze({
      backend: detection.backend,
      isolation: detection.backend === 'app-layer' ? 'application-only' : 'os',
      shellExecution: disableExecuteTools
        ? 'disabled'
        : detection.backend === 'app-layer'
          ? 'unsafe-override'
          : 'isolated',
      localMcpStdio: localMcpStdioEnabled ? 'unsafe-override' : 'disabled',
      sandboxNetwork: networkAccess,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    }),
  };
}

/**
 * 不安全开关只服务本地开发。正式构建发现任一开关时直接阻止启动，
 * 不能让安装环境中的意外变量静默关闭 Shell、MCP 或网络隔离。
 */
export function readSandboxUnsafeOverrides(
  environment: SandboxEnvironment,
): SandboxUnsafeOverrides {
  const overrides = {
    shell: environment.AGEN_UNSAFE_SHELL === '1',
    localMcpStdio: environment.AGEN_UNSAFE_MCP_STDIO === '1',
    network: environment.AGEN_UNSAFE_SANDBOX_NETWORK === '1',
  };
  if (
    environment.NODE_ENV === 'production'
    && (overrides.shell || overrides.localMcpStdio || overrides.network)
  ) {
    throw new Error('正式构建禁止使用 AGEN_UNSAFE_* 沙箱绕过开关');
  }
  return overrides;
}

/** 返回 Sandbox 必须永远拒绝写入的 Profile/Data SQLite 文件族。 */
export function sandboxProtectedPaths(activeDataDir: string): readonly string[] {
  return Object.freeze([
    ...sqliteFileSet(profileDbPath()),
    ...sqliteFileSet(dataDbPathFor(activeDataDir)),
  ]);
}

export function createSandboxRuntime(
  session: SessionStore,
  activeDataDir: string,
) {
  const policy = resolveSandboxRuntimePolicy(
    detectBackend(),
    readSandboxUnsafeOverrides(process.env),
  );
  const protectedPaths = sandboxProtectedPaths(activeDataDir);
  const runners = new Map<SessionId, CommandRunnerPort>();

  const getCommandRunner = (
    sessionId: SessionId,
  ): CommandRunnerPort | undefined => {
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
      protectedPaths,
      networkAccess: policy.networkAccess,
    });
    runners.set(sessionId, runner);
    return runner;
  };

  return {
    sandboxStatus: policy.status,
    disableExecuteTools: policy.disableExecuteTools,
    localMcpStdioEnabled: policy.localMcpStdioEnabled,
    getCommandRunner,
    /** 工作区变化后只淘汰绑定旧工作区的 Runner。 */
    invalidateSessionRunner: (sessionId: SessionId): void => {
      runners.delete(sessionId);
    },
    /** Session 永久删除后释放对应 Runner 引用。 */
    removeSessionRunner: (sessionId: SessionId): void => {
      runners.delete(sessionId);
    },
  };
}
