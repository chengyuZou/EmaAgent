// common/citations 测试:容错解析 + 去重 + Windows 路径。
import { describe, expect, it } from 'vitest';
import {
  parseMemoryCitation,
  parseMemoryCitationEntry,
} from '../common/citations.js';

describe('parseMemoryCitationEntry', () => {
  it('解析标准行', () => {
    expect(
      parseMemoryCitationEntry('MEMORY.md:234-236|note=[pointer]'),
    ).toEqual({ path: 'MEMORY.md', lineStart: 234, lineEnd: 236, note: 'pointer' });
  });

  it('trim 空白', () => {
    expect(
      parseMemoryCitationEntry('  turn_evidence/x.md:1-2|note=[a b]  '),
    ).toEqual({ path: 'turn_evidence/x.md', lineStart: 1, lineEnd: 2, note: 'a b' });
  });

  it('Windows 盘符路径:最后一个冒号是行号分隔', () => {
    expect(
      parseMemoryCitationEntry('C:\\work\\MEMORY.md:3-4|note=[w]'),
    ).toEqual({ path: 'C:\\work\\MEMORY.md', lineStart: 3, lineEnd: 4, note: 'w' });
  });

  it('行号非数字 → undefined(整行丢弃)', () => {
    expect(parseMemoryCitationEntry('MEMORY.md:abc-def|note=[x]')).toBeUndefined();
    expect(parseMemoryCitationEntry('MEMORY.md|note=[x]')).toBeUndefined();
    expect(parseMemoryCitationEntry('MEMORY.md:1-2|note=no-bracket')).toBeUndefined();
    expect(parseMemoryCitationEntry('')).toBeUndefined();
  });

  it('note 内嵌 |note=[ 会污染行号区间 → 整行丢弃(codex 行为)', () => {
    // rsplit 取最后一个 |note=[,location 残留 `|note=[x` → 行号区间解析失败 → None
    expect(
      parseMemoryCitationEntry('a.md:1-2|note=[x|note=[y]'),
    ).toBeUndefined();
  });

  it('note 内可含 `]`(strip 只去最末一个)', () => {
    expect(
      parseMemoryCitationEntry('a.md:1-2|note=[see ] x]'),
    ).toEqual({ path: 'a.md', lineStart: 1, lineEnd: 2, note: 'see ] x' });
  });
});

describe('parseMemoryCitation', () => {
  const sample = `
<oai-mem-citation>
<citation_entries>
MEMORY.md:234-236|note=[api pointer]
rollout_summaries/x.md:10-12|note=[format]
bad-line
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
019c6e27-e55b-73d1-87d8-4e01f1f75043
019c7714-3b77-74d1-9866-e1f484aae2ab
</rollout_ids>
</oai-mem-citation>`;

  it('解析 entries + 去重 ids;坏行跳过', () => {
    const citation = parseMemoryCitation([sample]);
    expect(citation).toBeDefined();
    expect(citation!.entries).toEqual([
      { path: 'MEMORY.md', lineStart: 234, lineEnd: 236, note: 'api pointer' },
      { path: 'rollout_summaries/x.md', lineStart: 10, lineEnd: 12, note: 'format' },
    ]);
    expect(citation!.sessionIds).toEqual([
      '019c6e27-e55b-73d1-87d8-4e01f1f75043',
      '019c7714-3b77-74d1-9866-e1f484aae2ab',
    ]);
  });

  it('支持 <thread_ids> 别名块', () => {
    const citation = parseMemoryCitation([
      '<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n<thread_ids>\na\nb\n</thread_ids>',
    ]);
    expect(citation!.sessionIds).toEqual(['a', 'b']);
  });

  it('跨多段文本合并', () => {
    const citation = parseMemoryCitation([
      '<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>',
      '<rollout_ids>\nid-1\n</rollout_ids>',
    ]);
    expect(citation!.entries).toHaveLength(1);
    expect(citation!.sessionIds).toEqual(['id-1']);
  });

  it('两段都空 → undefined', () => {
    expect(parseMemoryCitation(['no citation here'])).toBeUndefined();
    expect(parseMemoryCitation([])).toBeUndefined();
  });
});
