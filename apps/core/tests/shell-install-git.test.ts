// 测试 B-064: 安装 Git 是系统级特权操作, 必须先经 Permission Engine 审批;
// 拒绝返回 403 且不执行; 安装进行中并发请求返回 409, 不起第二个 winget。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppBindings } from '../src/wiring/index.js';
import type { GitInstallResult } from '@ema-agent/sandbox';

const { mockProbeShell, mockInstallGit } = vi.hoisted(() => ({
  mockProbeShell: vi.fn(() => ({ available: true as const, path: '/bin/bash' })),
  mockInstallGit: vi.fn(),
}));

vi.mock('@ema-agent/sandbox', () => ({
  probeShell: mockProbeShell,
  installGitViaWinget: mockInstallGit,
}));

import { shellRoute } from '../src/routes/shell.js';

function makeBindings(granted: boolean, reason = 'denied by user'): AppBindings {
  return {
    permission: {
      gate: vi.fn(async () => granted
        ? { granted: true as const }
        : { granted: false as const, reason }),
    },
  } as unknown as AppBindings;
}

function postInstall(app: ReturnType<typeof shellRoute>) {
  return app.request('/install-git', { method: 'POST' });
}

beforeEach(() => {
  mockInstallGit.mockReset();
});

describe('B-064 install-git 权限门禁', () => {
  it('审批通过后执行安装并返回结果', async () => {
    const bindings = makeBindings(true);
    mockInstallGit.mockResolvedValue({ ok: true, log: 'installed' } satisfies GitInstallResult);
    const app = shellRoute(bindings);

    const res = await postInstall(app);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(bindings.permission.gate).toHaveBeenCalledWith(
      'shell_install_git',
      expect.objectContaining({ installer: 'winget', packageId: 'Git.Git' }),
      { riskLevel: 'high', accessType: 'execute' },
      expect.objectContaining({ workspaceRoot: expect.any(String) }),
    );
    expect(mockInstallGit).toHaveBeenCalledTimes(1);
  });

  it('审批拒绝时返回 403 且绝不执行安装', async () => {
    const bindings = makeBindings(false);
    const app = shellRoute(bindings);

    const res = await postInstall(app);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'permission_denied' });
    expect(mockInstallGit).not.toHaveBeenCalled();
  });

  it('安装进行中并发请求返回 409, 不起第二个 winget', async () => {
    const bindings = makeBindings(true);
    let resolveInstall: ((result: GitInstallResult) => void) | undefined;
    mockInstallGit.mockImplementation(
      () => new Promise<GitInstallResult>((resolve) => { resolveInstall = resolve; }),
    );
    const app = shellRoute(bindings);

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
