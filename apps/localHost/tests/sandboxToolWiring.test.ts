// 测试 LocalHost 的 Sandbox 策略、Session Runner 生命周期和 Tool 基础设施装配。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuiltinTools } from '@ema-agent/tool-builtin';
import { asSessionId } from '@ema-agent/ids';
import { SessionStore } from '@ema-agent/session';
import { Database } from '@ema-agent/storage';
import {
  createSandboxRuntime,
  readSandboxUnsafeOverrides,
  resolveSandboxRuntimePolicy,
  sandboxProtectedPaths,
} from '../src/wiring/createSandboxRuntime.js';
import { createToolInfrastructure } from '../src/wiring/createToolInfrastructure.js';
import {
  dataDbPathFor,
  profileDbPath,
  sqliteFileSet,
} from '../src/storage-locations/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Sandbox runtime wiring', () => {
  it('没有系统级沙箱时默认关闭 Execute Tool 和本地 stdio MCP', () => {
    const policy = resolveSandboxRuntimePolicy(
      { backend: 'unisolated', degradeReason: 'sandbox unavailable' },
      { shell: false, localMcpStdio: false, network: false },
    );

    expect(policy).toMatchObject({
      disableExecuteTools: true,
      localMcpStdioEnabled: false,
      networkAccess: 'none',
      status: {
        kind: 'unisolated',
        isolation: 'application-only',
        shellExecution: 'disabled',
        localMcpStdio: 'disabled',
        sandboxNetwork: 'none',
      },
    });
    expect(policy.status.warning).toContain('sandbox unavailable');
  });

  it('显式开发开关只标记不安全能力，不把 unisolated 伪装成系统隔离', () => {
    const policy = resolveSandboxRuntimePolicy(
      { backend: 'unisolated' },
      { shell: true, localMcpStdio: true, network: true },
    );

    expect(policy.status).toMatchObject({
      isolation: 'application-only',
      shellExecution: 'unsafe-override',
      localMcpStdio: 'unsafe-override',
      sandboxNetwork: 'full',
    });
    expect(policy.disableExecuteTools).toBe(false);
  });

  it('正式构建物理拒绝任何不安全开关', () => {
    expect(() => readSandboxUnsafeOverrides({
      NODE_ENV: 'production',
      AGEN_UNSAFE_SHELL: '1',
    })).toThrow('正式构建禁止使用 AGEN_UNSAFE_*');
    expect(() => readSandboxUnsafeOverrides({
      NODE_ENV: 'production',
      AGEN_UNSAFE_MCP_STDIO: '1',
    })).toThrow('正式构建禁止使用 AGEN_UNSAFE_*');
    expect(() => readSandboxUnsafeOverrides({
      NODE_ENV: 'production',
      AGEN_UNSAFE_SANDBOX_NETWORK: '1',
    })).toThrow('正式构建禁止使用 AGEN_UNSAFE_*');
  });

  it('开发环境仍允许显式启用不安全能力', () => {
    expect(readSandboxUnsafeOverrides({
      NODE_ENV: 'development',
      AGEN_UNSAFE_SHELL: '1',
      AGEN_UNSAFE_MCP_STDIO: '1',
      AGEN_UNSAFE_SANDBOX_NETWORK: '1',
    })).toEqual({
      shell: true,
      localMcpStdio: true,
      network: true,
    });
  });

  it.each(['bubblewrap', 'sandbox-exec'] as const)(
    '%s 探测成功时如实报告系统隔离',
    (backend) => {
      const policy = resolveSandboxRuntimePolicy(
        { backend },
        { shell: false, localMcpStdio: false, network: false },
      );

      expect(policy.status).toMatchObject({
        backend,
        isolation: 'os',
        shellExecution: 'isolated',
      });
    },
  );

  it('保护 Profile/Data SQLite 主文件及其 WAL 文件族', () => {
    const activeDataDir = temporaryDirectory('ema-sandbox-paths-');

    expect(sandboxProtectedPaths(activeDataDir)).toEqual([
      ...sqliteFileSet(profileDbPath()),
      ...sqliteFileSet(dataDbPathFor(activeDataDir)),
    ]);
  });

  it('按 Session 缓存 Runner，并在工作区变化或删除时淘汰', () => {
    const database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    const firstWorkspace = temporaryDirectory('ema-workspace-a-');
    const secondWorkspace = temporaryDirectory('ema-workspace-b-');
    const activeDataDir = temporaryDirectory('ema-sandbox-runtime-');

    try {
      const session = new SessionStore({ db: database });
      const created = session.createSession({ workspaceRoot: firstWorkspace });
      const runtime = createSandboxRuntime(session, activeDataDir);

      const first = runtime.getCommandRunner(created.id);
      expect(first).toBeDefined();
      expect(runtime.getCommandRunner(created.id)).toBe(first);

      session.patchSession(created.id, { workspaceRoot: secondWorkspace });
      runtime.invalidateSessionRunner(created.id);
      const afterWorkspaceChange = runtime.getCommandRunner(created.id);
      expect(afterWorkspaceChange).toBeDefined();
      expect(afterWorkspaceChange).not.toBe(first);

      runtime.removeSessionRunner(created.id);
      expect(runtime.getCommandRunner(created.id)).not.toBe(afterWorkspaceChange);
    } finally {
      database.close();
    }
  });
});

describe('Tool infrastructure wiring', () => {
  it('内置工具顺序与内容 revision 可重复，禁用 Execute 时只移除 Bash', () => {
    const first = createToolFixture(false);
    const second = createToolFixture(false);
    const restricted = createToolFixture(true);

    try {
      const firstManifest = first.infrastructure.tools.manifestSnapshot();
      const secondManifest = second.infrastructure.tools.manifestSnapshot();
      const restrictedManifest = restricted.infrastructure.tools.manifestSnapshot();

      expect(firstManifest.entries.map(tool => tool.name))
        .toEqual(secondManifest.entries.map(tool => tool.name));
      expect(firstManifest.revision).toBe(secondManifest.revision);
      expect(first.infrastructure.tools.has(BuiltinTools.Bash.name)).toBe(true);
      expect(restricted.infrastructure.tools.has(BuiltinTools.Bash.name)).toBe(false);
      expect(restrictedManifest.entries.map(tool => tool.name)).toEqual(
        firstManifest.entries
          .map(tool => tool.name)
          .filter(name => name !== BuiltinTools.Bash.name),
      );
    } finally {
      first.database.close();
      second.database.close();
      restricted.database.close();
    }
  });

  it('Tool Result Store 按 Session 复用，Session 删除后释放缓存引用', () => {
    const fixture = createToolFixture(false);
    const sessionId = asSessionId('session-tool-result-test');

    try {
      const first = fixture.infrastructure.getSessionToolResultStore(sessionId);
      expect(fixture.infrastructure.getSessionToolResultStore(sessionId)).toBe(first);

      fixture.infrastructure.removeSessionToolState(sessionId);

      expect(fixture.infrastructure.getSessionToolResultStore(sessionId)).not.toBe(first);
    } finally {
      fixture.database.close();
    }
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createToolFixture(disableExecuteTools: boolean) {
  const database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  const activeDataDir = temporaryDirectory('ema-tool-infrastructure-');
  return {
    database,
    infrastructure: createToolInfrastructure(
      database,
      activeDataDir,
      disableExecuteTools,
    ),
  };
}
