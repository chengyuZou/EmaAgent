import { estimateTextTokens } from '@ema-agent/token';
import type { Chunk, Element } from '../types.js';
import type { Chunker, ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, linkChunks } from './base.js';
import { tokenChunk } from './token.js';

/**
 * Primary chunking strategy: split on title elements.
 *
 * Each title begins a new section. Elements under that title are collected
 * until the next same-or-higher-level title. If the accumulated text exceeds
 * maxTokens, the section is further split by the token chunker.
 *
 * Falls back to sliding-window chunking when the document has no titles.
 */
export class HeadingChunker implements Chunker {
  async chunk(elements: Element[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Promise<Chunk[]> {
    const hasTitles = elements.some(e => e.kind === 'title');
    if (!hasTitles) {
      return tokenChunk(elements, opts, 'doc');
    }

    const sections = splitIntoSections(elements);
    const chunks:   Chunk[] = [];
    let   docIdx   = 0;

    for (const section of sections) {
      const text        = elementsToText(section.body);
      const tokens      = estimateTextTokens(text);
      const sectionPath = section.path;

      if (tokens <= opts.maxTokens) {
        if (tokens < opts.minTokens && chunks.length > 0) {
          const prev = chunks[chunks.length - 1]!;
          prev.text       += '\n\n' + text;
          prev.tokenCount  = estimateTextTokens(prev.text);
          prev.elementKinds = [...new Set([...prev.elementKinds, ...elementKinds(section.body)])];
        } else {
          chunks.push(makeChunk(chunkId('doc', docIdx++), text, section.body, { fileName: '', mimeType: '', sectionPath }));
        }
      } else {
        const subChunks = tokenChunk(section.body, opts, `doc-${docIdx}`);
        docIdx += subChunks.length;
        chunks.push(...subChunks);
      }
    }

    linkChunks(chunks);
    return chunks;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Section {
  path: string[];
  body: Element[];
}

function splitIntoSections(elements: Element[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { path: [], body: [] };

  for (const el of elements) {
    if (el.kind === 'title') {
      if (current.body.length > 0) sections.push(current);
      current = { path: [...el.sectionPath, el.text], body: [] };
    } else {
      current.body.push(el);
    }
  }
  if (current.body.length > 0) sections.push(current);
  return sections;
}

function elementsToText(elements: Element[]): string {
  return elements.map(e => e.markdown ?? e.text).join('\n\n').trim();
}

function elementKinds(elements: Element[]): Element['kind'][] {
  return [...new Set(elements.map(e => e.kind))];
}

function makeChunk(
  id:      string,
  text:    string,
  body:    Element[],
  source:  { fileName: string; mimeType: string; sectionPath: string[] },
): Chunk {
  const markdown = body.some(e => e.markdown)
    ? body.map(e => e.markdown ?? e.text).join('\n\n').trim()
    : undefined;
  return {
    id,
    text,
    ...(markdown ? { markdown } : {}),
    elementKinds: elementKinds(body),
    tokenCount:   estimateTextTokens(text),
    source: {
      fileName:    source.fileName,
      mimeType:    source.mimeType,
      page:        body[0]?.page,
      sectionPath: source.sectionPath,
    },
  };
}
