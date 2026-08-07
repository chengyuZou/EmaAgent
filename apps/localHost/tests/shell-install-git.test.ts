// 测试 B-064: 安装 Git 是系统级特权操作, 必须先经 Permission Engine 审批;
// 拒绝返回 403 且不执行; 安装进行中并发请求返回 409, 不起第二个 winget。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PermissionAuthorizer } from '@ema-agent/permission';
import type { GitInstallResult } from '../src/gitInstaller.js';

const { mockProbeBash, mockInstallGit } = vi.hoisted(() => ({
  mockProbeBash: vi.fn(async () => ({ available: true as const, source: 'native' as const, path: '/bin/bash' })),
  mockInstallGit: vi.fn(),
}));

vi.mock('@ema-agent/sandbox', () => ({
  probeBash: mockProbeBash,
}));

vi.mock('../src/gitInstaller.js', () => ({
  installGitViaWinget: mockInstallGit,
}));

import { shellRoute } from '../src/routes/shell.js';

function makePermission(
  granted: boolean,
  reason = 'denied by user',
): PermissionAuthorizer {
  return {
    authorize: vi.fn(async () => granted
      ? { outcome: 'allow' as const, reason: { type: 'workspace' as const } }
      : { outcome: 'deny' as const, message: reason, reason: { type: 'headless' as const } }),
    clearSession: () => {},
  };
}

function postInstall(app: ReturnType<typeof shellRoute>) {
  return app.request('/install-git', { method: 'POST' });
}

beforeEach(() => {
  mockInstallGit.mockReset();
});

describe('B-064 install-git 权限门禁', () => {
  it('审批通过后执行安装并返回结果', async () => {
    const permission = makePermission(true);
    mockInstallGit.mockResolvedValue({ ok: true, log: 'installed' } satisfies GitInstallResult);
    const app = shellRoute(permission);

    const res = await postInstall(app);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(permission.authorize).toHaveBeenCalledWith(expect.objectContaining({
      tool: expect.objectContaining({ id: 'host.shell.installGit' }),
      input: expect.objectContaining({ installer: 'winget', packageId: 'Git.Git' }),
      intent: expect.objectContaining({ riskLevel: 'high', accessType: 'execute' }),
      context: expect.objectContaining({ mode: 'default', workspaceRoot: expect.any(String) }),
    }));
    expect(mockInstallGit).toHaveBeenCalledTimes(1);
  });

  it('审批拒绝时返回 403 且绝不执行安装', async () => {
    const permission = makePermission(false);
    const app = shellRoute(permission);

    const res = await postInstall(app);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'permission_denied' });
    expect(mockInstallGit).not.toHaveBeenCalled();
  });

  it('安装进行中并发请求返回 409, 不起第二个 winget', async () => {
    const permission = makePermission(true);
    let resolveInstall: ((result: GitInstallResult) => void) | undefined;
    mockInstallGit.mockImplementation(
      () => new Promise<GitInstallResult>((resolve) => { resolveInstall = resolve; }),
    );
    const app = shellRoute(permission);

    const first = postInstall(app);
    // 等第一个请求占住 in-flight 槽位。
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await postInstall(app);

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: 'install_in_progress' });
    expect(mockInstallGit).toHaveBeenCalledTimes(1);

    resolveInstall?.({ ok: true, log: 'done' });
    expect((await first).status).toBe(200);

    // 安装完成后槽位释放, 后续请求可以再次发起。
    mockInstallGit.mockResolvedValue({ ok: true, log: 'again' } satisfies GitInstallResult);
    const third = await postInstall(app);
    expect(third.status).toBe(200);
    expect(mockInstallGit).toHaveBeenCalledTimes(2);
  });
});
