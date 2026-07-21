import { readFile } from 'node:fs/promises';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_RE   = /^```(\w*)$/;

export class TextReader implements DocumentReader {
  async read(source: ReaderSource): Promise<ReadResult> {
    const raw = source.kind === 'path'
      ? await readFile(source.path, 'utf8')
      : new TextDecoder().decode(source.bytes);
    const ext = (source.kind === 'path' ? source.path : source.name)
      .split('.').pop()?.toLowerCase() ?? '';
    const blocks = ext === 'md' || ext === 'mdx' ? parseMarkdown(raw) : parsePlainText(raw);
    return { blocks };
  }
}

function parsePlainText(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const t = para.trim();
    if (t) blocks.push({ id: nextBlockId(), kind: 'paragraph', text: t, sectionPath: [] });
  }
  return blocks;
}

function parseMarkdown(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const lines = text.split('\n');
  const stack: string[] = [];
  let inFence = false, fenceLang = '', fenceLines: string[] = [];

  for (const line of lines) {
    if (!inFence) {
      const fm = FENCE_RE.exec(line);
      if (fm) { inFence = true; fenceLang = fm[1] ?? ''; fenceLines = []; continue; }

      const hm = HEADING_RE.exec(line);
      if (hm) {
        const level = hm[1]!.length;
        const title = hm[2]!.trim();
        while (stack.length >= level) stack.pop();
        stack.push(title);
        blocks.push({ id: nextBlockId(), kind: 'title', text: title, level, sectionPath: stack.slice(0, -1) });
        continue;
      }

      const t = line.trim();
      if (!t) continue;

      if (/^[-*]\s+/.test(t) || /^\d+\.\s/.test(t)) {
        blocks.push({ id: nextBlockId(), kind: 'list_item', text: t.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''), sectionPath: [...stack] });
      } else {
        const last = blocks[blocks.length - 1];
        if (last?.kind === 'paragraph' && last.sectionPath.join() === stack.join()) {
          last.text += ' ' + t;
        } else {
          blocks.push({ id: nextBlockId(), kind: 'paragraph', text: t, sectionPath: [...stack] });
        }
      }
    } else {
      if (line.startsWith('```')) {
        const code = fenceLines.join('\n');
        blocks.push({ id: nextBlockId(), kind: 'code', text: code,
          markdown: fenceLang ? `\`\`\`${fenceLang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
          sectionPath: [...stack] });
        inFence = false; fenceLines = [];
      } else { fenceLines.push(line); }
    }
  }

  if (inFence && fenceLines.length > 0) {
    const code = fenceLines.join('\n');
    blocks.push({ id: nextBlockId(), kind: 'code', text: code, markdown: `\`\`\`\n${code}\n\`\`\``, sectionPath: [...stack] });
  }
  return blocks;
}
