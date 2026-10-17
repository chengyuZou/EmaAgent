import { Hono } from 'hono';
import { z } from 'zod';
import { gitCompareDiff, gitRefs, gitSummary, gitWorkspaceDiff } from '@ema-agent/git';
import type { SessionStore } from '@ema-agent/session';
import { jsonBody, queryValidator } from '../validate.js';

type GitSessionStore = Pick<SessionStore, 'getSession'>;

const compareBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), branch: z.string().min(1) }),
  z.object({ kind: z.literal('commit'), sha: z.string().min(1) }),
]);

const workspaceQuery = z.object({
  scope: z.enum(['uncommitted', 'staged', 'unstaged']),
});

function cwd(sessions: GitSessionStore, sessionId: string): string | null {
  return sessions.getSession(sessionId).cwd;
}

export const sessionGitRoute = (sessions: GitSessionStore) =>
  new Hono()
    .get('/:sessionId/git/summary', async context => {
      const root = cwd(sessions, context.req.param('sessionId'));
      return context.json(root ? await gitSummary(root) : { status: 'not-a-repo' } as const);
    })
    .get('/:sessionId/git/workspace-diff', queryValidator(workspaceQuery), async context => {
      const root = cwd(sessions, context.req.param('sessionId'));
      return context.json(root
        ? await gitWorkspaceDiff(root, context.req.valid('query').scope)
        : { status: 'not-a-repo' } as const);
    })
    .get('/:sessionId/git/refs', async context => {
      const root = cwd(sessions, context.req.param('sessionId'));
      return context.json(root ? await gitRefs(root) : { status: 'not-a-repo' } as const);
    })
    .post('/:sessionId/git/compare', jsonBody(compareBody), async context => {
      const root = cwd(sessions, context.req.param('sessionId'));
      return context.json(root
        ? await gitCompareDiff(root, context.req.valid('json'))
        : { status: 'not-a-repo' } as const);
    });
