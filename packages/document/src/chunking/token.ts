import { estimateTextTokens } from '@ema-agent/token';
import type { Chunk, Element } from '../types.js';
import type { ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, linkChunks } from './base.js';

/**
 * Token-budget chunker. Splits a flat list of elements into chunks that each
 * fit within maxTokens. Used as a sub-splitter by HeadingChunker when a
 * section is too long, and directly when the document has no heading structure.
 */
export function tokenChunk(
  elements: Element[],
  opts:     ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  docId:    string = 'doc',
): Chunk[] {
  const chunks: Chunk[] = [];
  let   buf:    Element[] = [];
  let   tokens  = 0;
  let   idx     = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.map(e => e.markdown ?? e.text).join('\n\n').trim();
    if (!text) { buf = []; tokens = 0; return; }
    const markdown = buf.some(e => e.markdown)
      ? buf.map(e => e.markdown ?? e.text).join('\n\n').trim()
      : undefined;
    chunks.push({
      id:           chunkId(docId, idx++),
      text,
      ...(markdown ? { markdown } : {}),
      elementKinds: [...new Set(buf.map(e => e.kind))],
      tokenCount:   estimateTextTokens(text),
      source: {
        fileName:    '',
        mimeType:    '',
        page:        buf[0]?.page,
        sectionPath: buf[0]?.sectionPath ?? [],
      },
    });
    buf    = [];
    tokens = 0;
  };

  for (const el of elements) {
    const elTokens = estimateTextTokens(el.markdown ?? el.text);

    // Single element exceeds budget: emit it alone
    if (elTokens > opts.maxTokens) {
      flush();
      const text = el.markdown ?? el.text;
      chunks.push({
        id:           chunkId(docId, idx++),
        text,
        ...(el.markdown ? { markdown: el.markdown } : {}),
        elementKinds: [el.kind],
        tokenCount:   elTokens,
        source: {
          fileName:    '',
          mimeType:    '',
          page:        el.page,
          sectionPath: el.sectionPath,
        },
      });
      continue;
    }

    if (tokens + elTokens > opts.maxTokens) flush();
    buf.push(el);
    tokens += elTokens;
  }
  flush();

  linkChunks(chunks);
  return chunks;
}
