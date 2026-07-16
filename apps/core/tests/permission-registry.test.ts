import { describe, expect, it } from 'vitest';
import { PermissionPromptRegistry } from '../src/permissions/registry.js';

describe('PermissionPromptRegistry Session 生命周期', () => {
  it('删除 Session 时只取消该 Session 的待审批请求', async () => {
    const registry = new PermissionPromptRegistry(60_000);
    const first = registry.create({
      sessionId: 'session-a',
      turnId: 'turn-a',
      toolCallId: 'call-a',
    });
    const second = registry.create({
      sessionId: 'session-b',
      turnId: 'turn-b',
      toolCallId: 'call-b',
    });

    expect(registry.cancelForSession('session-a')).toBe(1);
    await expect(first.promise).resolves.toEqual({
      action: 'deny',
      reason: 'session deleted',
    });
    expect(registry.size()).toBe(1);

    registry.respond(second.promptId, { action: 'allow' });
    await expect(second.promise).resolves.toEqual({ action: 'allow' });
  });
});
