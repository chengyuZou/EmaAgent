import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyConsolidationEdits,
  parseConsolidationEdits,
  runConsolidationLlm,
} from '../consolidation/consolidation.js';
import { createRelationshipTargetPathCheck } from '../relationship/consolidation.js';

describe('Memory Consolidation', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('路径规则允许本批 characterName，不允许模型发明角色', () => {
    const allowed = createRelationshipTargetPathCheck([], ['艾玛']);
    expect(allowed('characters/艾玛/MEMORY.md')).toBe(true);
    expect(allowed('characters/陌生角色/MEMORY.md')).toBe(false);
    expect(createRelationshipTargetPathCheck([], ['..'])('characters/../MEMORY.md'))
      .toBe(false);
  });

  it('consumedTurnIds 来自实际装入输入的结果，不由 LLM 返回', async () => {
    const result = await runConsolidationLlm({
      memoryDirectory: root,
      currentPaths: [],
      isAllowedTargetPath: path => path === 'MEMORY.md',
      diffFile: path.join(root, 'missing.md'),
      unintegrated: [
        { turnId: 'turn-a', content: '偏好先讨论' },
        { turnId: 'turn-b', content: 'x'.repeat(1_000) },
      ],
      maxInputBytes: 100,
      systemTemplate: 'system',
      inputTemplate: 'input',
      complete: async () => '[]',
    });
    expect(result).toEqual({ edits: [], consumedTurnIds: ['turn-a'] });
  });

  it('校验后应用 write 和 delete', async () => {
    const edits = parseConsolidationEdits(
      '[{"path":"MEMORY.md","operation":"write","content":"# Memory"},'
        + '{"path":"topics/old.md","operation":"delete"}]',
      path => path === 'MEMORY.md' || path === 'topics/old.md',
    );
    await applyConsolidationEdits(root, edits, new AbortController().signal);
    expect(await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8')).toBe('# Memory');
  });

  it('拒绝 JSON 外说明和未定义字段', () => {
    expect(() => parseConsolidationEdits(
      '说明\n[{"path":"MEMORY.md","operation":"delete"}]',
      () => true,
    )).toThrow('合法 JSON 数组');
    expect(() => parseConsolidationEdits(
      '[{"path":"MEMORY.md","operation":"delete","reason":"旧了"}]',
      () => true,
    )).toThrow('多余字段');
  });
});
