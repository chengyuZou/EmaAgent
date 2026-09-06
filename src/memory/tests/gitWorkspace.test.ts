// 验证 Memory Git 变更文件的状态表达和字节裁剪.

import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  memoryGitDiffFile,
  prepareMemoryGitWorkspace,
  renderMemoryGitDiff,
} from '../common/gitWorkspace.js';

describe('Memory Git workspace diff', () => {
  it('renders added, modified and deleted files in one stable order', () => {
    const result = renderMemoryGitDiff(
      {
        changes: [
          { status: 'added', path: 'topics/typescript.md' },
          { status: 'modified', path: 'MEMORY.md' },
          { status: 'deleted', path: 'history/old.md' },
        ],
        unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
        truncated: false,
        unifiedSkipped: false,
      },
      1_024,
    );

    expect(result).toContain('- A topics/typescript.md');
    expect(result).toContain('- M MEMORY.md');
    expect(result).toContain('- D history/old.md');
    expect(result).toContain('@@ -1 +1 @@\n-old\n+new');
  });

  it('cuts unified diff content on a UTF-8 boundary', () => {
    const result = renderMemoryGitDiff(
      {
        changes: [{ status: 'modified', path: 'MEMORY.md' }],
        unifiedDiff: '修改'.repeat(100),
        truncated: true,
        unifiedSkipped: false,
      },
      17,
    );
    const renderedDiff = result
      .split('```diff\n')[1]
      ?.split('\n[workspace diff truncated')[0] ?? '';

    expect(Buffer.byteLength(renderedDiff.trimEnd(), 'utf8')).toBeLessThanOrEqual(17);
    expect(renderedDiff).not.toContain('\uFFFD');
    expect(result).toContain('[workspace diff truncated at 17 bytes]');
  });

  it('uses one fixed generated file inside the selected track', () => {
    expect(memoryGitDiffFile(path.join('memory', 'work'))).toBe(
      path.join('memory', 'work', 'memory_workspace_diff.md'),
    );
  });

  it('removes an interrupted Git index lock before preparing the baseline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ema-memory-git-'));
    const gitDirectory = path.join(root, '.git');
    const lockFile = path.join(gitDirectory, 'index.lock');
    await writeFile(path.join(root, 'MEMORY.md'), '# Memory\n');
    await mkdir(gitDirectory);
    await writeFile(lockFile, 'interrupted');

    await prepareMemoryGitWorkspace(root);

    await expect(stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
