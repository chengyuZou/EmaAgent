// 验证 Turn 证据同步后的文件集合和派生内容.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderTurnEvidence,
  syncTurnEvidence,
  turnEvidenceFileName,
  type TurnEvidence,
} from '../common/turnEvidence.js';

function evidence(partial: Partial<TurnEvidence> = {}): TurnEvidence {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    completedAt: new Date('2026-08-20T14:30:22.000Z'),
    content: '证据正文',
    ...partial,
  };
}

async function temporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-evidence-'));
}

async function markdownFiles(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, 'turn_evidence')))
    .filter((name) => name.endsWith('.md'))
    .sort();
}

describe('turn evidence rendering', () => {
  it('uses the Turn id as the stable file identity', () => {
    expect(turnEvidenceFileName(evidence({ title: 'Fix Build Cache' }))).toBe(
      '2026-08-20T14-30-22-turn-1-fix-build-cache.md',
    );
  });

  it('renders the common identity header and trimmed track content', () => {
    expect(renderTurnEvidence(evidence({ content: '  结论\n- 完成  ' }))).toBe(
      'session_id: session-1\n'
        + 'turn_id: turn-1\n'
        + 'completed_at: 2026-08-20T14:30:22.000Z\n\n'
        + '结论\n- 完成\n',
    );
  });
});

describe('syncTurnEvidence', () => {
  it('keeps only the newest configured number of files', async () => {
    const root = await temporaryRoot();
    await syncTurnEvidence(
      root,
      [
        evidence({ turnId: 'old', completedAt: new Date('2026-01-01T00:00:00Z') }),
        evidence({ turnId: 'new', completedAt: new Date('2026-01-03T00:00:00Z') }),
        evidence({ turnId: 'middle', completedAt: new Date('2026-01-02T00:00:00Z') }),
      ],
      2,
    );

    expect(await markdownFiles(root)).toEqual([
      '2026-01-02T00-00-00-middle.md',
      '2026-01-03T00-00-00-new.md',
    ]);
  });

  it('overwrites derived evidence but does not remove unrelated files', async () => {
    const root = await temporaryRoot();
    const item = evidence({ content: '数据库事实' });
    await syncTurnEvidence(root, [item], 10);

    const directory = path.join(root, 'turn_evidence');
    const [name] = await markdownFiles(root);
    const file = path.join(directory, name);
    await fs.writeFile(file, '用户临时改动', 'utf8');
    await fs.writeFile(path.join(directory, '说明.txt'), '保留', 'utf8');

    await syncTurnEvidence(root, [item], 10);

    expect(await fs.readFile(file, 'utf8')).toContain('数据库事实');
    expect(await fs.readFile(path.join(directory, '说明.txt'), 'utf8')).toBe('保留');
  });
});
