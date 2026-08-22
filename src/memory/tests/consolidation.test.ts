// 验证 Memory 整合的输入边界、文件计划与路径规则。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyConsolidationEdits,
  parseConsolidationEdits,
  runConsolidationLlm,
} from '../consolidation/consolidation.js';
import {
  createWorkTargetPathCheck,
  listWorkTargetPaths,
} from '../work/consolidation.js';
import {
  createRelationshipTargetPathCheck,
  listRelationshipTargetPaths,
} from '../relationship/consolidation.js';
import { MemoryConsolidationError } from '../errors.js';

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-consolidation-'));
}

describe('parseConsolidationEdits', () => {
  it('解析 write/delete 并归一 path（含 ./ 前缀与代码块包裹）', () => {
    const edits = parseConsolidationEdits(
      '```json\n'
        + '[{"path":"./topics/git.md","operation":"write","content":"# git"},'
        + '{"path":"extensions/notes/x.md","operation":"delete"}]\n'
        + '```',
      (relativePath) => new Set(['topics/git.md', 'extensions/notes/x.md']).has(relativePath),
    );
    expect(edits).toEqual([
      { path: 'topics/git.md', operation: 'write', content: '# git' },
      { path: 'extensions/notes/x.md', operation: 'delete' },
    ]);
  });

  it('白名单外路径拒绝（防越界）', () => {
    expect(() =>
      parseConsolidationEdits(
        '[{"path":"../secret.md","operation":"write","content":"x"}]',
        (relativePath) => relativePath === 'MEMORY.md',
      ),
    ).toThrow(MemoryConsolidationError);
  });

  it('非法 operation 拒绝', () => {
    expect(() =>
      parseConsolidationEdits(
        '[{"path":"MEMORY.md","operation":"rename"}]',
        (relativePath) => relativePath === 'MEMORY.md',
      ),
    ).toThrow(MemoryConsolidationError);
  });

  it('write 缺少 content 拒绝', () => {
    expect(() =>
      parseConsolidationEdits(
        '[{"path":"MEMORY.md","operation":"write"}]',
        (relativePath) => relativePath === 'MEMORY.md',
      ),
    ).toThrow(MemoryConsolidationError);
  });
});

describe('applyConsolidationEdits', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('write 新建/覆盖 + delete', async () => {
    await fs.mkdir(path.join(root, 'topics'), { recursive: true });
    await fs.writeFile(path.join(root, 'topics', 'git.md'), 'old');
    await applyConsolidationEdits(
      root,
      [
        { path: 'topics/git.md', operation: 'write', content: '# git\n' },
        { path: 'extensions/notes/x.md', operation: 'delete' },
      ],
      new AbortController().signal,
    );
    expect(await fs.readFile(path.join(root, 'topics', 'git.md'), 'utf8')).toBe('# git\n');
    await expect(fs.access(path.join(root, 'extensions', 'notes', 'x.md'))).rejects.toThrow();
  });

  it('越界路径拒绝（../ 不逃出记忆根）', async () => {
    await expect(
      applyConsolidationEdits(
        root,
        [{ path: '../escape.md', operation: 'write', content: 'x' }],
        new AbortController().signal,
      ),
    ).rejects.toThrow(MemoryConsolidationError);
  });
});

describe('runConsolidationLlm', () => {
  it('NO_MEMORY → 空改动（不写文件）', async () => {
    const root = await makeRoot();
    try {
      const plan = await runConsolidationLlm({
        memoryDirectory: root,
        currentPaths: [],
        isAllowedTargetPath: (relativePath) => relativePath === 'MEMORY.md',
        diffFile: path.join(root, 'missing-diff.md'),
        unintegrated: [],
        maxInputBytes: 1024,
        systemTemplate: 's',
        inputTemplate: 'i',
        complete: async () => 'NO_MEMORY',
      });
      expect(plan).toEqual({ edits: [], extractionJobIds: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('listTargetPaths', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('work 枚举存在的正式文件（posix 相对路径）', async () => {
    await fs.mkdir(path.join(root, 'topics'), { recursive: true });
    await fs.mkdir(path.join(root, 'history'), { recursive: true });
    await fs.mkdir(path.join(root, 'extensions', 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, 'MEMORY.md'), 'm');
    await fs.writeFile(path.join(root, 'topics', 'git.md'), 'g');
    await fs.writeFile(path.join(root, 'extensions', 'notes', 'n.md'), 'n');

    const targets = listWorkTargetPaths(root);
    expect(targets).toEqual(
      expect.arrayContaining(['MEMORY.md', 'topics/git.md', 'extensions/notes/n.md']),
    );
    // 不存在的文件不出现
    expect(targets).not.toContain('memory_summary.md');
  });

  it('relationship 枚举 characters 下的 MEMORY.md 与 history', async () => {
    await fs.mkdir(path.join(root, 'characters', 'ema', 'history'), { recursive: true });
    await fs.mkdir(path.join(root, 'extensions', 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, 'shared_user_memory.md'), 's');
    await fs.writeFile(path.join(root, 'characters', 'ema', 'MEMORY.md'), 'm');
    await fs.writeFile(path.join(root, 'characters', 'ema', 'history', 'h.md'), 'h');

    const targets = listRelationshipTargetPaths(root);
    expect(targets).toEqual(
      expect.arrayContaining([
        'shared_user_memory.md',
        'characters/ema/MEMORY.md',
        'characters/ema/history/h.md',
      ]),
    );
  });

  it('两轨允许创建正式文件，但不允许创建便签；关系角色目录必须已存在', async () => {
    // 自包含：本测试自己建角色目录，不依赖其它测试的执行顺序。
    await fs.mkdir(path.join(root, 'characters', 'ema'), { recursive: true });
    const workAllows = createWorkTargetPathCheck(root);
    const relationshipAllows = createRelationshipTargetPathCheck(root);

    expect(workAllows('topics/typescript.md')).toBe(true);
    expect(workAllows('extensions/notes/new.md')).toBe(false);
    expect(relationshipAllows('characters/ema/MEMORY.md')).toBe(true);
    expect(relationshipAllows('characters/ema/history/2026-08-22.md')).toBe(true);
    expect(relationshipAllows('characters/ema/extensions/notes/new.md')).toBe(false);
    // 方案 Y：不存在的角色目录被拒绝（不能发明角色目录）。
    expect(relationshipAllows('characters/ghost/MEMORY.md')).toBe(false);
    expect(relationshipAllows('characters/ghost/history/2026-08-22.md')).toBe(false);
  });

  it('只把完整进入本轮输入的提取结果列为已消费', async () => {
    const root = await makeRoot();
    try {
      const plan = await runConsolidationLlm({
        memoryDirectory: root,
        currentPaths: [],
        isAllowedTargetPath: () => true,
        diffFile: path.join(root, 'missing-diff.md'),
        unintegrated: [
          {
            jobId: 'job-1',
            kind: 'work_extraction',
            turnId: 'turn-1',
            content: '第一条可以完整进入',
            integratedAt: null,
          },
          {
            jobId: 'job-2',
            kind: 'work_extraction',
            turnId: 'turn-2',
            content: 'x'.repeat(1_000),
            integratedAt: null,
          },
        ],
        maxInputBytes: 180,
        systemTemplate: 's',
        inputTemplate: 'i',
        complete: async () => '[]',
      });

      expect(plan.extractionJobIds).toEqual(['job-1']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
