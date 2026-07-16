// 这里测试相对工具路径会以当前 workspace 为基准解析，不能因进程工作目录不同而越界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionEngine } from '../src/checker.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('relative workspace path', () => {
  it('工作区内相对读取按 workspaceRoot 自动放行', async () => {
    const workspaceRoot = makeTempDir();
    fs.mkdirSync(path.join(workspaceRoot, 'src'));
    const engine = new PermissionEngine({
      mode: 'auto',
      rules: [],
      ask: async () => ({ action: 'deny' }),
    });

    const outcome = await engine.gate(
      { id: 'builtin.search.glob', name: 'Glob' },
      { path: 'src' },
      { riskLevel: 'low', accessType: 'read', extractPath: input => (input as { path: string }).path },
      { workspaceRoot, sessionId: 'session-test' },
    );

    expect(outcome).toMatchObject({ granted: true, decisionReason: { type: 'workingDir' } });
  });

  it('越过 workspaceRoot 的相对路径不会走工作区自动放行', async () => {
    const parent = makeTempDir();
    const workspaceRoot = path.join(parent, 'workspace');
    fs.mkdirSync(workspaceRoot);
    const engine = new PermissionEngine({
      mode: 'auto',
      rules: [],
      ask: async () => ({ action: 'deny', reason: '测试拒绝越界' }),
    });

    const outcome = await engine.gate(
      { id: 'builtin.search.glob', name: 'Glob' },
      { path: '..' },
      { riskLevel: 'low', accessType: 'read', extractPath: input => (input as { path: string }).path },
      { workspaceRoot, sessionId: 'session-test' },
    );

    expect(outcome).toMatchObject({ granted: false, reason: '测试拒绝越界' });
  });

  it('新文件位于指向工作区外的目录链接时不会自动放行', async () => {
    const parent = makeTempDir();
    const workspaceRoot = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspaceRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const engine = new PermissionEngine({
      mode: 'auto',
      rules: [],
      ask: async () => ({ action: 'deny', reason: '测试拒绝链接越界' }),
    });

    const outcome = await engine.gate(
      { id: 'builtin.file.write', name: 'Write' },
      { file_path: 'escape/new.txt' },
      { riskLevel: 'medium', accessType: 'write', extractPath: input => (input as { file_path: string }).file_path },
      { workspaceRoot, sessionId: 'session-test' },
    );

    expect(outcome).toMatchObject({ granted: false, reason: '测试拒绝链接越界' });
  });
});

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-permission-path-'));
  tempDirs.push(directory);
  return directory;
}
