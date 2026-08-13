// 递归分隔符 chunker：先按标题章节归组，再按段落→行→句→词的优先级把文本切进 token 预算。
import { estimateTextTokens } from '@ema-agent/token';
import type { DocumentBlock, DocumentChunk, DocumentBlockKind } from '../types.js';
import type { Chunker, ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, normalizeChunkSizes } from './base.js';

// 切分优先级：段落 → 行 → 中文句 → 英文句 → 词。
// 中文标点单独列在正则之前——中文句子之间没有空格，
// 需要先按句号类标点干净切分，再回落到后顾正则。
const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '…', /(?<=[.!?])\s+/, ' '] as const;

export class RecursiveChunker implements Chunker {
  async chunk(blocks: DocumentBlock[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Promise<DocumentChunk[]> {
    const assetId = opts.assetId ?? 'doc';

    // 按 sectionPath 边界把连续块归组为章节
    const sections = groupIntoSections(blocks);
    const raw: DocumentChunk[] = [];
    let idx = 0;

    for (const sec of sections) {
      const text = sec.blocks.map(b => b.markdown ?? b.text).join('\n\n').trim();
      if (!text) continue;
      const pieces = splitRecursive(text, opts.maxTokens);
      for (const piece of pieces) {
        raw.push({
          id:          chunkId(assetId, idx++),
          assetId,
          text:        piece,
          blockKinds:  collectKinds(sec.blocks),
          tokenCount:  estimateTextTokens(piece),
          page:        sec.blocks[0]?.page,
          sectionPath: sec.path,
        });
      }
    }

    const merged   = normalizeChunkSizes(raw, opts, assetId);
    const overlapped = applyOverlap(merged, opts);
    return overlapped;
  }
}

/** 公共辅助：让 SemanticChunker 无需类实例即可作为兜底使用。 */
export function recursiveChunk(
  blocks:  DocumentBlock[],
  opts:    ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  assetId: string       = 'doc',
): DocumentChunk[] {
  const sections = groupIntoSections(blocks);
  const raw: DocumentChunk[] = [];
  let idx = 0;

  for (const sec of sections) {
    const text = sec.blocks.map(b => b.markdown ?? b.text).join('\n\n').trim();
    if (!text) continue;
    const pieces = splitRecursive(text, opts.maxTokens);
    for (const piece of pieces) {
      raw.push({
        id:          chunkId(assetId, idx++),
        assetId,
        text:        piece,
        blockKinds:  collectKinds(sec.blocks),
        tokenCount:  estimateTextTokens(piece),
        page:        sec.blocks[0]?.page,
        sectionPath: sec.path,
      });
    }
  }

  const merged    = normalizeChunkSizes(raw, opts, assetId);
  const overlapped = applyOverlap(merged, opts);
  return overlapped;
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

interface Section { path: string[]; blocks: DocumentBlock[] }

/**
 * 按阅读序做 run-length 归组：只与当前打开的 Section 比 path。
 * 相同 path 被不同 path 隔开（A B A）时不合流——同名标题会在文档里复现，
 * 两个 A 字面相等但属于不同的节，合流会把不相邻内容粘进同一分块。
 */
function groupIntoSections(blocks: DocumentBlock[]): Section[] {
  const secs: Section[] = [];
  let cur: Section = { path: [], blocks: [] };

  for (const b of blocks) {
    const pathKey = b.sectionPath.join('\x00');
    const curKey  = cur.path.join('\x00');
    if (pathKey !== curKey && cur.blocks.length > 0) {
      secs.push(cur);
      cur = { path: b.sectionPath, blocks: [] };
    } else if (cur.blocks.length === 0) {
      cur.path = b.sectionPath;
    }
    cur.blocks.push(b);
  }
  if (cur.blocks.length > 0) secs.push(cur);
  return secs;
}

/**
 * 贪心装包 + 逐级下切：当前档分隔符切出的片段顺次累积进预算；
 * 单段仍超预算时升到下一档分隔符重切——这是唯一的递归点。
 */
function splitRecursive(text: string, maxTokens: number, sepIdx = 0): string[] {
  if (estimateTextTokens(text) <= maxTokens) return [text];

  const sep = SEPARATORS[sepIdx];
  // 所有分隔符都用尽仍超长：按字符对半硬切，语义完整性让位于预算上限。
  if (sep === undefined) return hardCutToFit(text, maxTokens);

  const results: string[] = [];
  let current = '';
  for (const part of text.split(sep)) {
    if (!part.trim()) continue;
    const candidate = current ? current + (typeof sep === 'string' ? sep : ' ') + part : part;
    if (estimateTextTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }
    // current 只由放得下的片段累积而来，必然已满足预算——直接收尾，不递归。
    if (current) results.push(current);
    current = '';
    if (estimateTextTokens(part) <= maxTokens) {
      current = part;
    } else {
      results.push(...splitRecursive(part, maxTokens, sepIdx + 1));
    }
  }
  if (current) results.push(current);
  return results;
}

/** 字符对半硬切。显式栈保持阅读序；单字符兜底（旧递归版在 length=1 时 mid=0 会无限递归）。 */
function hardCutToFit(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  const stack = [text];
  while (stack.length > 0) {
    const piece = stack.pop()!;
    if (estimateTextTokens(piece) <= maxTokens || piece.length <= 1) {
      out.push(piece);
      continue;
    }
    const mid = Math.floor(piece.length / 2);
    // 后段先入栈，弹出顺序即阅读序。
    stack.push(piece.slice(mid), piece.slice(0, mid));
  }
  return out;
}

/**
 * 把前一个分块的末尾 `overlap` 个 token 前置到当前分块，
 * 让检索能拿到跨块引用的上下文。
 */
function applyOverlap(chunks: DocumentChunk[], opts: ChunkOptions): DocumentChunk[] {
  if (opts.overlap <= 0 || chunks.length < 2) return chunks;
  return chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = chunks[i - 1]!;
    const overlapText = takeTailTokens(prev.text, opts.overlap);
    if (!overlapText) return chunk;
    const text = overlapText + ' ' + chunk.text;
    return { ...chunk, text, tokenCount: estimateTextTokens(text) };
  });
}

function takeTailTokens(text: string, targetTokens: number): string {
  // 近似：英文 1 token ≈ 4 字符，中文更少
  const approxChars = targetTokens * 4;
  const tail = text.slice(-approxChars);
  // 截到词边界
  const spaceIdx = tail.indexOf(' ');
  return spaceIdx > 0 ? tail.slice(spaceIdx + 1) : tail;
}

function collectKinds(blocks: DocumentBlock[]): DocumentBlockKind[] {
  return [...new Set(blocks.map(b => b.kind))];
}
