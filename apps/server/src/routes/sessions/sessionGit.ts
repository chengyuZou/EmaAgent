// 提供 Session 工作区的 Git 只读摘要、工作区 diff 与比较查询;route 只做身份解析与结果转换,不承载查询编排。
import { Hono } from 'hono';
import { asSessionId } from '@ema-agent/ids';
import { gitCompareDiff, gitRefs, gitSummary, gitWorkspaceDiff } from '@ema-agent/git-utils';
import type { SessionStore } from '@ema-agent/session';

export function sessionGitRoute(session: Pick<SessionStore, 'getSession'>): Hono {
  const app = new Hono();

  const resolveWorkspace = (id: string): { root: string } | { error: Response } => {
    let workspaceRoot: string | null;
    try {
      workspaceRoot = session.getSession(asSessionId(id)).workspaceRoot;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('session_not_found')) {
        return { error: new Response(JSON.stringify({ error: 'session_not_found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        }) };
      }
      throw error;
    }
    if (!workspaceRoot) {
      // 无工作区的 Session 没有可摘要的对象;前端本就不会发起,显式 400 表明协议边界。
      return { error: new Response(JSON.stringify({ error: 'no_workspace' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      }) };
    }
    return { root: workspaceRoot };
  };

  app.get('/:id/git-summary', async (c) => {
    const resolved = resolveWorkspace(c.req.param('id'));
    if ('error' in resolved) return resolved.error;
    return c.json(await gitSummary(resolved.root));
  });

  app.get('/:id/git-diff', async (c) => {
    const resolved = resolveWorkspace(c.req.param('id'));
    if ('error' in resolved) return resolved.error;
    return c.json(await gitWorkspaceDiff(resolved.root));
  });

  app.get('/:id/git-refs', async (c) => {
    const resolved = resolveWorkspace(c.req.param('id'));
    if ('error' in resolved) return resolved.error;
    return c.json(await gitRefs(resolved.root));
  });

  app.get('/:id/git-compare', async (c) => {
    const resolved = resolveWorkspace(c.req.param('id'));
    if ('error' in resolved) return resolved.error;
    const type = c.req.query('type');
    const ref = c.req.query('ref') ?? '';
    // 分支名与 SHA 只作为 git 参数透传(不经过 shell);空值与未知类型显式拒绝。
    if ((type !== 'commit' && type !== 'branch') || ref.length === 0 || ref.length > 200) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const target = type === 'commit'
      ? { kind: 'commit' as const, sha: ref }
      : { kind: 'branch' as const, branch: ref };
    return c.json(await gitCompareDiff(resolved.root, target));
  });

  return app;
}
