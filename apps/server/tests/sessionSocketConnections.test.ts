// 验证 Session WebSocket 按 Session 隔离, 且同一 Session 可同时发布给多个观察窗口.
import { describe, expect, it } from 'vitest';
import {
  SessionSocketConnections,
  sessionClientMessageSchema,
  type SessionBusinessMessage,
} from '../src/routes/ws/session.js';

describe('SessionSocketConnections', () => {
  it('publishes only to attached sockets in the target Session', () => {
    const connections = new SessionSocketConnections();
    const first: SessionBusinessMessage[] = [];
    const second: SessionBusinessMessage[] = [];
    const otherSession: SessionBusinessMessage[] = [];

    const detachFirst = connections.attach('session-a', { send: message => first.push(message) });
    connections.attach('session-a', { send: message => second.push(message) });
    connections.attach('session-b', { send: message => otherSession.push(message) });

    const message = { type: 'session_running_changed', running: null } as const;
    connections.publish('session-a', message);

    expect(first).toEqual([message]);
    expect(second).toEqual([message]);
    expect(otherSession).toEqual([]);

    detachFirst();
    connections.publish('session-a', message);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });
});

describe('sessionClientMessageSchema', () => {
  it('requires the real Turn or Compact identity for each cancellation request', () => {
    expect(sessionClientMessageSchema.safeParse({
      type: 'cancel_turn',
      requestId: 'request-1',
    }).success).toBe(false);
    expect(sessionClientMessageSchema.safeParse({
      type: 'cancel_turn',
      requestId: 'request-2',
      turnId: 'turn-1',
    }).success).toBe(true);
    expect(sessionClientMessageSchema.safeParse({
      type: 'cancel_compact',
      requestId: 'request-3',
      compactId: 'compact-1',
    }).success).toBe(true);
  });

  it('separates direct UserMessage and Queue commands and removes the old mixed entry', () => {
    const payload = {
      sessionMode: 'chat',
      narrativePolicy: 'auto',
      input: [{ type: 'text', text: 'hello' }],
    };
    expect(sessionClientMessageSchema.safeParse({
      type: 'send_user_message',
      requestId: 'direct-1',
      payload,
    }).success).toBe(true);
    expect(sessionClientMessageSchema.safeParse({
      type: 'queue_user_message',
      requestId: 'queue-1',
      payload,
    }).success).toBe(true);
    expect(sessionClientMessageSchema.safeParse({
      type: 'enqueue_input',
      requestId: 'old-1',
      payload,
    }).success).toBe(false);
  });

  it('accepts a ToolCall ID as the AgentRun cancellation identity', () => {
    expect(sessionClientMessageSchema.safeParse({
      type: 'cancel_agent_run',
      requestId: 'cancel-agent-1',
      agentRunId: 'provider-tool-call-1',
    }).success).toBe(true);
  });
});
