// 测试工作区、symlink 和内部目录能力不会因路径形式不同而越界。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import type { PermissionRequest } from '../types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Permission 路径授权', () => {
  it('相对读取以请求工作区解析，无工作区时 fail-closed', async () => {
    const workspaceRoot = makeTempDir();
    fs.mkdirSync(path.join(workspaceRoot, 'src'));
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const request = fileRequest('src', 'read', workspaceRoot);

    expect(await engine.authorize(request)).toEqual({
      outcome: 'allow',
      reason: { type: 'workspace' },
    });

    expect(await engine.authorize({
      ...request,
      context: { mode: 'default' },
    })).toMatchObject({
      outcome: 'deny',
      reason: { type: 'invalidRequest' },
    });
  });

  it('新文件经目录链接落到工作区外时不能被 acceptEdits 自动放行', async () => {
    const parent = makeTempDir();
    const workspaceRoot = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(workspaceRoot, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const request: PermissionRequest = {
      ...fileRequest('escape/new.txt', 'write', workspaceRoot),
      context: { mode: 'acceptEdits', workspaceRoot },
    };

    const result = await engine.authorize(
      request,
      async () => ({ action: 'deny', reason: '链接目标越过工作区' }),
    );

    expect(result).toMatchObject({ outcome: 'deny', message: '链接目标越过工作区' });
  });

  it('隐藏真实路径的 scratchpad Tool 只有拿到明确能力才静默放行', async () => {
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const runtimeRoot = makeTempDir();
    const request: PermissionRequest = {
      tool: { id: 'builtin.scratchpad.write', name: 'ScratchpadWrite' },
      input: { key: 'note' },
      intent: {
        riskLevel: 'low',
        accessType: 'write',
        internalPathCapability: 'turnScratchpad',
        promptPolicy: 'whenRequired',
      },
      context: {
        mode: 'default',
        sessionId: asSessionId('session-a'),
        turnId: asTurnId('turn-a'),
        internalPaths: { turnScratchpad: runtimeRoot },
      },
    };

    expect(await engine.authorize(request)).toEqual({
      outcome: 'allow',
      reason: { type: 'internalCapability', capability: 'turnScratchpad' },
    });

    expect(await engine.authorize({
      ...request,
      context: { mode: 'default' },
    })).toMatchObject({
      outcome: 'deny',
      reason: { type: 'headless' },
    });
  });

  it('工作区外绝对路径默认模式进入用户询问, 不由引擎一票否决', async () => {
    const workspaceRoot = makeTempDir();
    const outsideFile = path.join(makeTempDir(), 'notes.txt');
    fs.writeFileSync(outsideFile, 'outside');
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const request = fileRequest(outsideFile, 'read', workspaceRoot);

    // 没有批准界面时 headless 拒绝——证明它没有走"工作区读取自动放行"捷径。
    const headless = await engine.authorize(request);
    expect(headless).toMatchObject({
      outcome: 'deny',
      reason: { type: 'headless' },
    });

    // 工作区外由用户裁决: 允许就放行, 拒绝就拦截, 不是工具/引擎硬性一票拒绝。
    const allowed = await engine.authorize(
      request,
      async () => ({ action: 'allow' }),
    );
    expect(allowed).toMatchObject({ outcome: 'allow' });

    const denied = await engine.authorize(
      request,
      async () => ({ action: 'deny', reason: '用户拒绝' }),
    );
    expect(denied).toMatchObject({ outcome: 'deny', message: '用户拒绝' });
  });

  it('acceptEdits 模式只自动放行工作区写入, 工作区外写入仍需用户裁决', async () => {
    const workspaceRoot = makeTempDir();
    const outsideFile = path.join(makeTempDir(), 'new.txt');
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const request: PermissionRequest = {
      ...fileRequest(outsideFile, 'write', workspaceRoot),
      context: { mode: 'acceptEdits', workspaceRoot },
    };

    const headless = await engine.authorize(request);
    expect(headless).toMatchObject({
      outcome: 'deny',
      reason: { type: 'headless' },
    });

    const allowed = await engine.authorize(
      request,
      async () => ({ action: 'allow' }),
    );
    expect(allowed).toMatchObject({ outcome: 'allow' });
  });
});

function fileRequest(
  targetPath: string,
  accessType: 'read' | 'write',
  workspaceRoot: string,
): PermissionRequest {
  return {
    tool: { id: `builtin.file.${accessType}`, name: accessType === 'read' ? 'FileRead' : 'FileWrite' },
    input: { path: targetPath },
    intent: {
      riskLevel: accessType === 'read' ? 'low' : 'medium',
      accessType,
      targets: [{ path: targetPath, accessType }],
      promptPolicy: 'whenRequired',
    },
    context: { mode: 'default', workspaceRoot },
  };
}

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-permission-'));
  tempDirs.push(directory);
  return directory;
}
