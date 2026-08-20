// common/storage 测试:稳定序文件名 + 证据文件重建/剪枝。
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rebuildTurnEvidenceFiles,
  renderTurnEvidenceBody,
  retainedRows,
  syncTurnEvidenceFiles,
  turnEvidenceFileStem,
  turnEvidenceFileStemFromParts,
} from '../common/storage.js';
import type { StageOutputRow } from '../common/storage.js';

function row(partial: Partial<StageOutputRow>): StageOutputRow {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    completedAt: new Date('2026-08-20T14:30:22.000Z'),
    turnSummary: 'summary',
    ...partial,
  };
}

describe('turnEvidenceFileStemFromParts', () => {
  it('时间戳-短hash 前缀,slug 清洗后追加', () => {
    const stem = turnEvidenceFileStemFromParts(
      's1', 't1', new Date('2026-08-20T14:30:22.000Z'), 'Fix build cache',
    );
    expect(stem).toMatch(/^2026-08-20T14-30-22-[0-9a-zA-Z]{4}-fix_build_cache$/);
  });

  it('无 slug 时只有时间戳-短hash', () => {
    const stem = turnEvidenceFileStemFromParts(
      's1', 't1', new Date('2026-08-20T14:30:22.000Z'), undefined,
    );
    expect(stem).toMatch(/^2026-08-20T14-30-22-[0-9a-zA-Z]{4}$/);
  });

  it('slug 清洗:非字母数字→_,去尾_,空回落无 slug', () => {
    const a = turnEvidenceFileStemFromParts(
      's', 't', new Date('2026-01-01T00:00:00.000Z'), 'hello! world__',
    );
    // `!` 与空格各自独立变 `_`(codex 行为),故为 hello__world
    expect(a.endsWith('-hello__world')).toBe(true);

    const b = turnEvidenceFileStemFromParts(
      's', 't', new Date('2026-01-01T00:00:00.000Z'), '!!!',
    );
    expect(b.endsWith('_!!!')).toBe(false);
    expect(b).toMatch(/^2026-01-01T00-00-00-[0-9a-zA-Z]{4}$/);
  });

  it('slug 截断到 60 字符', () => {
    const longSlug = 'a'.repeat(120);
    const stem = turnEvidenceFileStemFromParts(
      's', 't', new Date('2026-01-01T00:00:00.000Z'), longSlug,
    );
    const slugPart = stem.slice(stem.lastIndexOf('-') + 1);
    expect(slugPart.length).toBe(60);
  });

  it('同一时刻不同 sessionId 大概率不碰撞(UUID 主路径:低 32 位异或)', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const stems = new Set(
      Array.from({ length: 50 }, (_, i) => {
        const sessionId = `019c6e27-e55b-73d1-87d8-${String(i).padStart(12, '0')}`;
        return turnEvidenceFileStemFromParts(sessionId, 'turn-id', date, 'slug');
      }),
    );
    expect(stems.size).toBe(50);
  });

  it('非 UUID id 走 31 哈希 fallback(长随机串仍能区分)', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const a = turnEvidenceFileStemFromParts('thread-abc-very-long-random-1', 't1', date, 'x');
    const b = turnEvidenceFileStemFromParts('thread-abc-very-long-random-2', 't1', date, 'x');
    expect(a).not.toBe(b);
  });

  it('时间序:同 session 不同完成时刻按时间升序', () => {
    const t1 = new Date('2026-01-01T10:00:00.000Z');
    const t2 = new Date('2026-01-02T10:00:00.000Z');
    const a = turnEvidenceFileStemFromParts('s', 't', t1, 'x');
    const b = turnEvidenceFileStemFromParts('s', 't', t2, 'x');
    expect(a < b).toBe(true);
  });
});

describe('renderTurnEvidenceBody', () => {
  it('元数据头稳定键序 + 空行 + 摘要 + 证据', () => {
    const body = renderTurnEvidenceBody(
      row({
        sessionId: 'sess',
        turnId: 'turn',
        completedAt: new Date('2026-08-20T14:30:22.000Z'),
        cwd: '/work',
        evidenceRootPath: '/work',
        gitBranch: 'main',
        turnSummary: '  summary text  ',
        rawEvidence: 'evidence lines',
      }),
    );
    expect(body).toContain('session_id: sess\n');
    expect(body).toContain('turn_id: turn\n');
    expect(body).toContain('completed_at: 2026-08-20T14:30:22.000Z\n');
    expect(body).toContain('cwd: /work\n');
    expect(body).toContain('evidence_root: /work\n');
    expect(body).toContain('git_branch: main\n');
    expect(body).toContain('\n\nsummary text\n\nevidence lines\n');
  });

  it('无 git_branch/evidence 时不写空行头', () => {
    const body = renderTurnEvidenceBody(row({ turnSummary: 's' }));
    expect(body).not.toContain('git_branch:');
    expect(body).not.toContain('evidence_root:');
  });
});

describe('retainedRows', () => {
  it('保留前 maxItems 条(稳定序)', () => {
    const rows = [row({ turnId: '1' }), row({ turnId: '2' }), row({ turnId: '3' })];
    expect(retainedRows(rows, 2).map((r) => r.turnId)).toEqual(['1', '2']);
  });
});

describe('rebuild / sync / prune', () => {
  async function tempRoot(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-test-'));
  }

  it('rebuild:清空目录后按保留集全写', async () => {
    const root = await tempRoot();
    const rows = [
      row({ turnId: '1', completedAt: new Date('2026-01-01T00:00:00.000Z') }),
      row({ turnId: '2', completedAt: new Date('2026-01-02T00:00:00.000Z') }),
    ];
    await rebuildTurnEvidenceFiles(root, rows, 10);

    const dir = path.join(root, 'turn_evidence');
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(2);

    // 第二次 rebuild 时先写入"用户手改的杂项",验证被清空覆盖
    await fs.writeFile(path.join(dir, 'stale.md'), 'user edit', 'utf8');
    await rebuildTurnEvidenceFiles(root, rows.slice(0, 1), 10);
    const after = await fs.readdir(dir);
    expect(after.filter((f) => f.endsWith('.md'))).toHaveLength(1);
    expect(after).not.toContain('stale.md');
  });

  it('sync:剪掉 keep 之外的旧文件', async () => {
    const root = await tempRoot();
    const rows = [
      row({ turnId: '1', completedAt: new Date('2026-01-01T00:00:00.000Z') }),
      row({ turnId: '2', completedAt: new Date('2026-01-02T00:00:00.000Z') }),
    ];
    await rebuildTurnEvidenceFiles(root, rows, 10);

    // 缩小到 1 条并换内容 → sync 应剪掉第 2 条并更新第 1 条
    const updated = [
      row({ turnId: '1', completedAt: new Date('2026-01-01T00:00:00.000Z'), turnSummary: 'new' }),
    ];
    await syncTurnEvidenceFiles(root, updated, 10);

    const dir = path.join(root, 'turn_evidence');
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(1);
    const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
    expect(content).toContain('new');
  });

  it('turnEvidenceFileStem(row) 与 fromParts 一致', () => {
    const r = row({ sessionId: 's', turnId: 't', slug: 'hello' });
    expect(turnEvidenceFileStem(r)).toBe(
      turnEvidenceFileStemFromParts('s', 't', r.completedAt, 'hello'),
    );
  });
});
