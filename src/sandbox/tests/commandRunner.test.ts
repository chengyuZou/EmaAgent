// CommandRunner 工作区边界与 shell 解析测试:
// 空 workspaceRoot 拒绝构造; 探测未结算时 start 诚实报错; 结算后正常执行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandRunner } from '../commandRunner.js';
import { probeBash, resetBashProbeCache } from '../bashProbe.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-runner-'));
}

afterEach(() => {
  resetBashProbeCache();
});

describe('CommandRunner 工作区边界', () => {
  it('空 workspaceRoot 直接拒绝构造', () => {
    expect(() => new CommandRunner({
      workspaceRoot: '',
      writablePaths: [],
      forbiddenPaths: [],
      networkAccess: 'none',
    })).toThrow('需要明确的 workspaceRoot');
  });
});

describe('CommandRunner shell 解析', () => {
  it('探测尚未结算时 start 诚实报错, 不假装能执行', async () => {
    resetBashProbeCache();
    const root = makeWorkspace();
    const runner = new CommandRunner({
      workspaceRoot: root,
      writablePaths: [root],
      forbiddenPaths: [],
      networkAccess: 'none',
    });
    // 构造里的兜底预热是异步的, 同一拍内 peek 必然未结算。
    expect(() => runner.start('echo hi')).toThrow('Shell 探测尚未完成');
    // 兜底预热确实在跑: 等它结算后同一路径恢复可用。
    await probeBash();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('探测结算后 start 经 unisolated 后端真实执行', async () => {
    const probe = await probeBash();
    if (!probe.available || probe.source === 'wsl') return; // wsl 路由语义另测
    const root = makeWorkspace();
    const runner = new CommandRunner({
      workspaceRoot: root,
      writablePaths: [root],
      forbiddenPaths: [],
      networkAccess: 'none',
    });
    const result = await runner.run('echo sandbox-ok', { timeoutMs: 5_000 });
    expect(result.stdout).toContain('sandbox-ok');
    expect(result.exitCode).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
