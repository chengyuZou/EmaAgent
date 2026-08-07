// 探测本机 Shell，并在权限审批后执行 Git 安装。
import { Hono } from 'hono';
import { probeBash } from '@ema-agent/sandbox';
import { installGitViaWinget, type GitInstallResult } from '../gitInstaller.js';
import type { PermissionAuthorizer } from '@ema-agent/permission';

// 安装是系统级副作用: 同一时刻只允许一个在跑, 并发请求明确拒绝而不是再起 winget。
let installInFlight: Promise<GitInstallResult> | null = null;

export function shellRoute(permission: PermissionAuthorizer): Hono {
  const app = new Hono();

  /**
   * GET /api/system/shell
   * Returns the current shell probe result (cached; use ?fresh=1 to re-probe).
   */
  app.get('/', async (c) => {
    const fresh = c.req.query('fresh') === '1';
    return c.json(await probeBash({ fresh }));
  });

  /**
   * POST /api/system/shell/install-git
   * Installs Git for Windows via winget. Blocks until done (1-3 min).
   * Re-probes on success so the next GET reflects the new state.
   *
   * B-064: 系统级安装属于特权操作, 先经 Permission Engine 审批(high + execute)
   * 再执行; 拒绝返回 403, 不绕开"工具意图必须独立审批"的红线直接 spawn。
   */
  app.post('/install-git', async (c) => {
    const outcome = await permission.authorize({
      tool: {
        id: 'host.shell.installGit',
        name: '安装 Git',
        description: '通过 winget 为当前用户安装 Git for Windows',
      },
      input: {
        operation: 'install_software',
        installer: 'winget',
        packageId: 'Git.Git',
        scope:     'user',
      },
      intent: {
        riskLevel: 'high',
        accessType: 'execute',
        promptPolicy: 'whenRequired',
      },
      context: {
        mode: 'default',
        workspaceRoot: process.cwd(),
      },
    });
    if (outcome.outcome === 'deny') {
      return c.json({ error: 'permission_denied', reason: outcome.message }, 403);
    }

    if (installInFlight) {
      return c.json({ error: 'install_in_progress', message: '已有 Git 安装任务在进行中' }, 409);
    }

    installInFlight = installGitViaWinget();
    try {
      const result = await installInFlight;
      return c.json(result);
    } finally {
      installInFlight = null;
    }
  });

  return app;
}
