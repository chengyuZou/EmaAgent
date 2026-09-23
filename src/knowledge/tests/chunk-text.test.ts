// 测试 Chunk 只保留唯一正文，同时原子 Block 仍优先采用结构化 Markdown 表达。
import { describe, expect, it, vi } from 'vitest';
import { RecursiveChunker } from '../chunking/recursive.js';
import { SemanticChunker } from '../chunking/semantic.js';
import type { CallEmbed, DocumentBlock } from '../types.js';

const tableBlock: DocumentBlock = {
  id: 'table-1',
  kind: 'table',
  text: 'name value alpha 1',
  markdown: '| name | value |\n| --- | --- |\n| alpha | 1 |',
  sectionPath: ['Metrics'],
};

const options = {
  assetId: 'asset-table',
  maxTokens: 256,
  overlap: 0,
  minTokens: 0,
};

describe('DocumentChunk 唯一正文', () => {
  it('RecursiveChunker 把 Block markdown 选为 text，不再复制 markdown 字段', async () => {
    const chunks = await new RecursiveChunker().chunk([tableBlock], options);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(tableBlock.markdown);
    expect(chunks[0]).not.toHaveProperty('markdown');
  });

  it('SemanticChunker 的原子块使用同一正文规则且不调用 embed', async () => {
    const embed = vi.fn(async () => {
      throw new Error('atomic block must not embed');
    }) as CallEmbed;
    const chunks = await new SemanticChunker().chunk([tableBlock], { ...options, embed });

    expect(embed).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(tableBlock.markdown);
    expect(chunks[0]).not.toHaveProperty('markdown');
  });
});
