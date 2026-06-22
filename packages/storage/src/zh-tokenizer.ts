// Chinese word segmentation for FTS5 (RAGFlow-style: segment, then BM25 over words).
//
// jieba's general dict (@node-rs/jieba/dict) is the portable equivalent of
// RAGFlow's trie dict. We segment chunk text at index time into a space-joined
// `tokens` string that FTS5 indexes word-by-word, and segment the query the same
// way at search time so 2-char Chinese words match (which trigram's 3-char window
// could not). Latin/ASCII runs are left intact by jieba.
//
// The native module + dict are loaded lazily on first use and cached. If the
// native binary is unavailable (e.g. unsupported platform), we degrade to the raw
// text so FTS still works (Latin) rather than throwing.

import { Jieba } from '@node-rs/jieba';
// Explicit .js: @node-rs/jieba has no package `exports` map, so ESM subpath
// resolution won't append the extension for us.
import { dict } from '@node-rs/jieba/dict.js';

let _jieba: Jieba | null | undefined;

function getJieba(): Jieba | null {
  if (_jieba !== undefined) return _jieba;
  try {
    _jieba = Jieba.withDict(dict);
  } catch (err) {
    console.warn('[storage] @node-rs/jieba unavailable, FTS falls back to raw text:',
      err instanceof Error ? err.message : err);
    _jieba = null;
  }
  return _jieba;
}

/**
 * Segment text into a space-joined token string for FTS indexing / querying.
 * Returns the original text (lightly space-normalized) when jieba is unavailable.
 */
export function segmentForFts(text: string): string {
  if (!text.trim()) return '';
  const j = getJieba();
  if (!j) return text.replace(/\s+/g, ' ').trim();
  return j.cut(text, true).filter(t => t.trim()).join(' ');
}
