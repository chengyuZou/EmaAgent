import { estimateTextTokens } from '@ema-agent/token';
import type { Chunk, Element } from '../types.js';
import type { Chunker, ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, linkChunks } from './base.js';
import { splitSentences } from '../utils/sentences.js';

/**
 * Sentence-boundary chunker. Splits text into sentences, then groups them
 * into token-budgeted chunks without any embedding calls.
 *
 * Atomic elements (code, table, image) are always emitted as individual chunks
 * rather than mixed into sentence groups, preserving their integrity.
 *
 * This is the fallback strategy used by SemanticChunker when embedding fails.
 */
export class SentenceChunker implements Chunker {
  async chunk(elements: Element[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    let idx = 0;

    type SentWithEl = { text: string; el: Element };
    let buf: SentWithEl[] = [];
    let bufTokens = 0;

    const flush = (): void => {
      if (buf.length === 0) return;
      const text    = buf.map(s => s.text).join(' ').trim();
      const tokens  = estimateTextTokens(text);
      const firstEl = buf[0]!.el;
      buf       = [];
      bufTokens = 0;
      if (!text) return;

      if (tokens < opts.minTokens && chunks.length > 0) {
        const prev = chunks[chunks.length - 1]!;
        prev.text       += ' ' + text;
        prev.tokenCount  = estimateTextTokens(prev.text);
        return;
      }
      chunks.push(makeChunk(chunkId('doc', idx++), text, firstEl));
    };

    for (const el of elements) {
      // Atomic elements: flush current sentence buffer, emit as standalone chunk
      if (isAtomic(el)) {
        flush();
        const text = el.markdown ?? el.text;
        chunks.push({
          id:           chunkId('doc', idx++),
          text,
          ...(el.markdown ? { markdown: el.markdown } : {}),
          elementKinds: [el.kind],
          tokenCount:   estimateTextTokens(text),
          source: {
            fileName:    '',
            mimeType:    '',
            page:        el.page,
            sectionPath: el.sectionPath,
          },
        });
        continue;
      }

      // Title: flush and start fresh (preserve heading as chunk boundary)
      if (el.kind === 'title') {
        flush();
        const text  = el.text;
        const toks  = estimateTextTokens(text);
        buf       = [{ text, el }];
        bufTokens = toks;
        continue;
      }

      // Text elements: split into sentences and fill buffer
      const sentences = splitSentences(el.text);
      if (sentences.length === 0) continue;

      for (const sent of sentences) {
        const toks = estimateTextTokens(sent);

        // Single sentence larger than budget: emit alone
        if (toks > opts.maxTokens) {
          flush();
          chunks.push(makeChunk(chunkId('doc', idx++), sent, el));
          continue;
        }

        if (bufTokens + toks > opts.maxTokens) flush();
        buf.push({ text: sent, el });
        bufTokens += toks;
      }
    }
    flush();

    linkChunks(chunks);
    return chunks;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ATOMIC_KINDS = new Set<Element['kind']>(['code', 'table', 'image']);

function isAtomic(el: Element): boolean {
  return ATOMIC_KINDS.has(el.kind);
}

function makeChunk(id: string, text: string, el: Element): Chunk {
  return {
    id,
    text,
    elementKinds: [el.kind],
    tokenCount:   estimateTextTokens(text),
    source: {
      fileName:    '',
      mimeType:    '',
      page:        el.page,
      sectionPath: el.sectionPath,
    },
  };
}

// Re-export DEFAULT_CHUNK_OPTIONS so callers don't need a separate import
export { DEFAULT_CHUNK_OPTIONS };
