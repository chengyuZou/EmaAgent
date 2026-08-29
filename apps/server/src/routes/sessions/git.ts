// 把 Session 绑定的工作区投影为只读 Git 摘要、差异和比较范围。
import { Hono } from 'hono';
import { z } from 'zod';
import { gitCompareDiff, gitRefs, gitSummary, gitWorkspaceDiff } from '@ema-agent/git';
import type { SessionStore } from '@ema-agent/session';
import { jsonBody } from '../validate.js';

type GitSessionStore = Pick<SessionStore, 'getSession'>;

const compareBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), branch: z.string().min(1) }),
  z.object({ kind: z.literal('commit'), sha: z.string().min(1) }),
]);

function workspaceRoot(sessions: GitSessionStore, sessionId: string): string | null {
  return sessions.getSession(sessionId).workspaceRoot;
}

export const sessionGitRoute = (sessions: GitSessionStore) =>
  new Hono()
    .get('/:sessionId/git/summary', async context => {
      const root = workspaceRoot(sessions, context.req.param('sessionId'));
      return context.json(root ? await gitSummary(root) : { capability: 'not-a-repo' } as const);
    })
    .get('/:sessionId/git/workspace-diff', async context => {
      const root = workspaceRoot(sessions, context.req.param('sessionId'));
      return context.json(root ? await gitWorkspaceDiff(root) : { capability: 'not-a-repo' } as const);
    })
    .get('/:sessionId/git/refs', async context => {
      const root = workspaceRoot(sessions, context.req.param('sessionId'));
      return context.json(root ? await gitRefs(root) : { capability: 'not-a-repo' } as const);
    })
    .post('/:sessionId/git/compare', jsonBody(compareBody), async context => {
      const root = workspaceRoot(sessions, context.req.param('sessionId'));
      return context.json(root
        ? await gitCompareDiff(root, context.req.valid('json'))
        : { capability: 'not-a-repo' } as const);
    });
