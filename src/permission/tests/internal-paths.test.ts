// 这里测试内部路径不会越界，以及没有传入 scratchpad 目录时不会自动放行。

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
} from '../paths/internalPaths.js';
import type { PermissionContext, ToolPermissionMeta } from '../types.js';

const runtimeRoot = path.resolve('D:/ema-data/sessions/session-a/scratchpad/turn-a');

function context(withCapability = true): PermissionContext {
  return {
    workspaceRoot: '',
    sessionId: 'session-a',
    turnId: 'turn-a',
    internalPaths: withCapability ? { turnScratchpad: runtimeRoot } : undefined,
  };
}

describe('内部目录能力', () => {
  it('只放行 RuntimePaths 显式授予的根目录及其后代', () => {
    expect(checkEditableInternalPath(path.join(runtimeRoot, 'entry'), context())).toBe('allow');
    expect(checkReadableInternalPath(runtimeRoot, context())).toBe('allow');
    expect(checkEditableInternalPath(`${runtimeRoot}-sibling/entry`, context())).toBe('passthrough');
    expect(checkReadableInternalPath(path.resolve('D:/ema-data/sessions/session-b'), context())).toBe('passthrough');
  });

  it('不再根据 SessionId 猜测用户主目录下的旧路径', () => {
    const guessedLegacyPath = path.resolve('D:/Users/example/.ema-agent/sessions/session-a/scratch/file');
    expect(checkEditableInternalPath(guessedLegacyPath, context(false))).toBe('passthrough');
    expect(checkReadableInternalPath(guessedLegacyPath, context(false))).toBe('passthrough');
  });

  it('封装型 scratchpad 工具必须持有对应能力才能静默放行', async () => {
    const engine = new PermissionEngine({ mode: 'ask' }, new InMemoryPermissionRuleStore());
    const meta: ToolPermissionMeta = {
      riskLevel: 'low',
      accessType: 'write',
      internalPathCapability: 'turnScratchpad',
    };

    await expect(engine.gate('ScratchpadWrite', { key: 'a' }, meta, context())).resolves.toEqual({
      granted: true,
      decisionReason: {
        type: 'internalCapability',
        capability: 'turnScratchpad',
        root: runtimeRoot,
      },
    });

    await expect(engine.gate('ScratchpadWrite', { key: 'a' }, meta, context(false))).resolves.toMatchObject({
      granted: false,
    });
  });
});
