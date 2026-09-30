// 验证结构化 Tool 错误以字段展示, 普通文字仍原样显示.
import { describe, expect, it } from 'vitest';
import { renderToolError } from '../src/chat/messages/toolBlocks/tool-renderers.js';

describe('renderToolError', () => {
  it('把 Goal 错误的嵌套事实展开为可读字段', () => {
    expect(renderToolError(JSON.stringify({
      error: 'goal_version_conflict',
      goal: { id: 'goal-id', status: 'completed', version: 2 },
      currentGoal: null,
      instruction: 'Stop pursuing this Goal.',
    }))).toEqual([
      { key: 'error', value: 'goal_version_conflict' },
      { key: 'goal.id', value: 'goal-id' },
      { key: 'goal.status', value: 'completed' },
      { key: 'goal.version', value: '2', mono: true },
      { key: 'currentGoal', value: '' },
      { key: 'instruction', value: 'Stop pursuing this Goal.' },
    ]);
  });

  it('普通文字与数组不伪装成字段', () => {
    expect(renderToolError('权限不足')).toBeNull();
    expect(renderToolError('[1,2]')).toBeNull();
  });
});
