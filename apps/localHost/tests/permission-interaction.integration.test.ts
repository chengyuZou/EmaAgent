// 联调 PermissionEngine、统一 Session 交互队列与两组 HTTP Route 的真实等待和恢复流程。

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asSessionId,
  asToolCallId,
  asTurnId,
} from '@ema-agent/ids';
import type {
  PermissionRequest,
  PermissionStreamEvent,
} from '@ema-agent/permission';
import { Database } from '@ema-agent/storage';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import { permissionRoute } from '../src/routes/permission.js';
import { registerAskUserRoutes } from '../src/routes/turns/askUser.js';
import { buildPermissionSubsystem } from '../src/wiring/permission-bootstrap.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('Permission 与 AskUser 统一交互链', () => {
  it('同 Session 严格串行，并通过真实 HTTP 响应结束两种等待', async () => {
    const database = new Database({ memory: true, kind: 'profile' });
    databases.push(database);
    database.migrate();

    const subsystem = buildPermissionSubsystem(null, database.sqlite);
    const app = new Hono();
    const turns = new Hono();
    registerAskUserRoutes(turns, subsystem.interactionQueue);
    app.route('/api/permission', permissionRoute(
      subsystem.permission,
      subsystem.interactionQueue,
    ));
    app.route('/api/turns', turns);

    const sessionId = asSessionId('session-permission-integration');
    const turnId = asTurnId('turn-permission-integration');
    const toolCallId = asToolCallId('tool-call-permission-integration');
    const events: PermissionStreamEvent[] = [];
    const request: PermissionRequest = {
      tool: {
        id: 'bash',
        name: 'Bash',
        description: '执行一条终端命令',
      },
      input: { command: 'echo integration' },
      intent: {
        riskLevel: 'high',
        accessType: 'execute',
        promptPolicy: 'whenRequired',
      },
      context: {
        mode: 'default',
        sessionId,
        turnId,
        toolCallId,
      },
    };

    const permissionDecision = subsystem.permission.authorize(
      request,
      subsystem.buildAskForTurn({
        sessionId,
        turnId,
        toolCallId,
        emit: event => events.push(event),
      }),
    );

    const askUserRequest: AskUserRequiredEvent = {
      type: 'ask_user_required',
      sessionId,
      turnId,
      promptId: 'ask-user-integration',
      questions: [{
        id: 'continue',
        header: '继续',
        question: '是否继续？',
      }],
    };
    const askUserWait = subsystem.askUserRegistry.createWithId(
      askUserRequest.promptId,
      undefined,
      turnId,
      askUserRequest,
    );

    const required = events.at(0);
    expect(required?.type).toBe('permission_required');
    if (!required || required.type !== 'permission_required') {
      throw new Error('Permission 没有进入等待队列');
    }

    const permissionPending = await app.request('/api/permission/pending');
    await expect(permissionPending.json()).resolves.toMatchObject({
      count: 1,
      prompts: [{
        promptId: required.promptId,
        prompt: {
          sessionId,
          turnId,
          toolCallId,
          toolId: 'bash',
        },
      }],
    });

    const askUserPending = await app.request('/api/turns/pending/ask-user');
    await expect(askUserPending.json()).resolves.toMatchObject({
      count: 1,
      prompts: [{ request: { promptId: askUserRequest.promptId } }],
    });

    // AskUser 虽然能被重连接口看见，但仍在同 Session 的 Permission 后面排队。
    const prematureAskResponse = await app.request(
      `/api/turns/${turnId}/ask-user/${askUserRequest.promptId}/respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { continue: 'yes' } }),
      },
    );
    expect(prematureAskResponse.status).toBe(404);

    const permissionResponse = await app.request(
      `/api/permission/${turnId}/${required.promptId}/respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'allow' }),
      },
    );
    expect(permissionResponse.status).toBe(200);
    await expect(permissionDecision).resolves.toMatchObject({
      outcome: 'allow',
      reason: { type: 'user', action: 'allow' },
    });
    expect(events.at(1)).toMatchObject({
      type: 'permission_resolved',
      promptId: required.promptId,
      decision: 'allow',
    });

    const askUserResponse = await app.request(
      `/api/turns/${turnId}/ask-user/${askUserRequest.promptId}/respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { continue: 'yes' } }),
      },
    );
    expect(askUserResponse.status).toBe(200);
    await expect(askUserWait.promise).resolves.toEqual({
      status: 'answered',
      answers: { continue: 'yes' },
    });
    expect(subsystem.interactionQueue.size()).toBe(0);
  });
});
