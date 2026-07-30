// 验证 Session Git 摘要路由的身份解析、404/400 边界与结果透传。
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asSessionId } from '@ema-agent/ids';
import type { SessionStore } from '@ema-agent/session';
import { sessionGitRoute } from '../src/routes/sessions/sessionGit.js';

type RouteSession = Pick<SessionStore, 'getSession'>;

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createSessionStore(workspaceRoot: string | null): RouteSession {
  return {
    getSession: vi.fn(() => {
      if (workspaceRoot === 'missing') throw new Error('session_not_found: x');
      return { workspaceRoot } as ReturnType<SessionStore['getSession']>;
    }),
  };
}

describe('sessionGitRoute', () => {
  it('不存在的 Session 返回 404', async () => {
    const app = sessionGitRoute(createSessionStore('missing'));
    const res = await app.request(`/${asSessionId('s-1')}/git-summary`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session_not_found' });
  });

  it('无工作区的 Session 返回 400', async () => {
    const app = sessionGitRoute(createSessionStore(null));
    const res = await app.request(`/${asSessionId('s-1')}/git-summary`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no_workspace' });
  });

  it('非仓库工作区透传 not-a-repo,仓库工作区透传 ok', async () => {
    if (!gitAvailable()) return; // 无 git 的环境无法产出 ok 摘要,跳过而非假通过。
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-route-'));
    try {
      const notRepo = sessionGitRoute(createSessionStore(temp));
      const resA = await notRepo.request(`/${asSessionId('s-1')}/git-summary`);
      expect(resA.status).toBe(200);
      expect((await resA.json() as { capability: string }).capability).toBe('not-a-repo');

      // 测试进程 cwd 必定位于本仓库内。
      const inRepo = sessionGitRoute(createSessionStore(process.cwd()));
      const resB = await inRepo.request(`/${asSessionId('s-1')}/git-summary`);
      expect(resB.status).toBe(200);
      expect((await resB.json() as { capability: string }).capability).toBe('ok');
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('git-diff 复用同一身份解析:404/400/ok', async () => {
    const missing = sessionGitRoute(createSessionStore('missing'));
    expect((await missing.request(`/${asSessionId('s-1')}/git-diff`)).status).toBe(404);

    const noWs = sessionGitRoute(createSessionStore(null));
    expect((await noWs.request(`/${asSessionId('s-1')}/git-diff`)).status).toBe(400);

    if (!gitAvailable()) return; // 无 git 环境无法产出 ok,跳过而非假通过。
    const inRepo = sessionGitRoute(createSessionStore(process.cwd()));
    const res = await inRepo.request(`/${asSessionId('s-1')}/git-diff`);
    expect(res.status).toBe(200);
    const body = await res.json() as { capability: string };
    expect(body.capability).toBe('ok');
  });
});
