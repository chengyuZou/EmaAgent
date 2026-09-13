// 测试 Session cwd 与项目授权目录分离后的多根路径判定。
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathInAnyWorkingDir } from '../paths/workspaceBoundary.js';

describe('pathInAnyWorkingDir', () => {
  it('只认当前 Project folders，不因 Session cwd 曾位于旧文件夹而放行', () => {
    const base = path.join(os.tmpdir(), 'ema-workspace-boundary');
    const folderA = path.join(base, 'a');
    const folderB = path.join(base, 'b');

    expect(pathInAnyWorkingDir(path.join(folderB, 'file.txt'), {
      workspaceRoots: [folderB],
    })).toBe(true);
    expect(pathInAnyWorkingDir(path.join(folderA, 'file.txt'), {
      workspaceRoots: [folderB],
    })).toBe(false);
  });

  it('空清单不把进程目录当作隐式授权根', () => {
    expect(pathInAnyWorkingDir(process.cwd(), { workspaceRoots: [] })).toBe(false);
  });
});
