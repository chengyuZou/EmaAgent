// 验证 Agent WebSocket 按 Session 隔离，且同一 Session 可同时发布给多个观察窗口。
import { describe, expect, it } from 'vitest';
import {
  AgentSocketConnections,
  agentClientMessageSchema,
  type AgentServerMessage,
} from '../src/routes/ws/agent.js';

describe('AgentSocketConnections', () => {
  it('publishes only to attached sockets in the target Session', () => {
    const connections = new AgentSocketConnections();
    const first: AgentServerMessage[] = [];
    const second: AgentServerMessage[] = [];
    const otherSession: AgentServerMessage[] = [];

    const detachFirst = connections.attach('session-a', { send: message => first.push(message) });
    connections.attach('session-a', { send: message => second.push(message) });
    connections.attach('session-b', { send: message => otherSession.push(message) });

    const message = { type: 'session_state', execution: null } as const;
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

describe('agentClientMessageSchema', () => {
  it('rejects a cancellation command without its execution identity', () => {
    expect(agentClientMessageSchema.safeParse({
      type: 'cancel_execution',
      commandId: 'command-1',
    }).success).toBe(false);
  });
});
