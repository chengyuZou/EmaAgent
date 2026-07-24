// 测试同一轮模型响应中，Skill 收窄能力后已入队的后续工具也不能越权执行。
import { describe, expect, it, vi } from 'vitest';
import {
  createToolManifestSnapshot,
  ToolExecutionRuntime,
  type BuiltTool,
} from '@ema-agent/tools';
import { TurnPolicy } from '../policy.js';

describe('Skill capability 与工具执行器集成', () => {
  it('在 Permission Engine 前重新检查 Skill 更新后的能力作用域', async () => {
    const policy = new TurnPolicy(createToolManifestSnapshot([
      fakeTool('builtin.skill.call', 'SkillCall'),
      fakeTool('builtin.shell.bash', 'Bash'),
    ], 1));
    const dispatched: string[] = [];
    const permissionGate = vi.fn(async () => ({ granted: true as const }));

    const tools = {
      has: () => true,
      prepare: (name: string, input: unknown) => ({
        id: name === 'SkillCall' ? 'builtin.skill.call' : 'builtin.shell.bash',
        name,
        origin: { kind: 'builtin' },
        input,
        permissionMeta: {},
        isReadOnly: false,
        isConcurrencySafe: name !== 'SkillCall',
        requiresUserInteraction: false,
        maxResultBytes: 1024,
      }),
      validateContext: () => ({ valid: true, context: {} }),
      execute: async (prepared: { name: string }) => {
        dispatched.push(prepared.name);
        if (prepared.name === 'SkillCall') {
          policy.capabilities().restrict({
            source: 'skill:read-only',
            allowedToolPatterns: ['SkillCall'],
          });
        }
        return 'ok';
      },
    };

    const executor = new ToolExecutionRuntime({
      sessionId: 'session-skill' as never,
      turnId: 'turn-skill' as never,
      allows: name => policy.allows(name),
      tools: tools as never,
      permission: { gate: permissionGate } as never,
      permCtx: { workspaceRoot: null } as never,
      toolContext: {
        sessionId: 'session-skill',
        turnId: 'turn-skill',
        workspaceRoot: '',
        signal: new AbortController().signal,
        readFileState: new Map(),
        toolCapabilities: policy.capabilities(),
      },
      pushEv: () => undefined,
      signal: () => undefined,
    });

    executor.addTool(0, 'call-skill', 'SkillCall', { skill: 'read-only' });
    executor.addTool(1, 'call-bash', 'Bash', { command: 'echo blocked' });
    await executor.join();

    expect(dispatched).toEqual(['SkillCall']);
    expect(permissionGate).toHaveBeenCalledTimes(1);
    expect(executor.getResults()).toEqual([
      expect.objectContaining({ toolUseId: 'call-skill', isError: false }),
      expect.objectContaining({
        toolUseId: 'call-bash',
        isError: true,
        errorCode: 'policy/denied',
      }),
    ]);
  });
});

function fakeTool(id: string, name: string): BuiltTool {
  return {
    id,
    name,
    origin: { kind: 'builtin' },
    description: name,
    descriptor: () => ({ name, description: name, inputJsonSchema: {} }),
  } as BuiltTool;
}
