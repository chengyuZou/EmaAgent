import { readFile } from 'node:fs/promises';
import type { Element } from '../types.js';
import type { DocumentReader, ReaderSource } from './base.js';
import { nextElementId } from './base.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_RE   = /^```(\w*)$/;

/**
 * Reader for plain text and Markdown files.
 * Markdown headings become title elements; fenced code blocks become code
 * elements; everything else is paragraph or list_item.
 */
export class TextReader implements DocumentReader {
  async read(source: ReaderSource): Promise<Element[]> {
    const raw = source.kind === 'path'
      ? await readFile(source.path, 'utf8')
      : new TextDecoder().decode(source.bytes);

    const ext = (source.kind === 'path' ? source.path : source.name)
      .split('.').pop()?.toLowerCase() ?? '';

    return ext === 'md' || ext === 'mdx'
      ? parseMarkdown(raw)
      : parsePlainText(raw);
  }
}

function parsePlainText(text: string): Element[] {
  const elements: Element[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    elements.push({
      id: nextElementId(),
      kind: 'paragraph',
      text: trimmed,
      sectionPath: [],
    });
  }
  return elements;
}

function parseMarkdown(text: string): Element[] {
  const elements: Element[] = [];
  const lines        = text.split('\n');
  const sectionStack: string[] = [];
  let inFence        = false;
  let fenceLang      = '';
  let fenceLines:      string[] = [];

  for (const line of lines) {
    if (!inFence) {
      const fenceMatch = FENCE_RE.exec(line);
      if (fenceMatch) {
        inFence   = true;
        fenceLang = fenceMatch[1] ?? '';
        fenceLines = [];
        continue;
      }

      const headingMatch = HEADING_RE.exec(line);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const title = headingMatch[2]!.trim();
        // pop sectionStack to match current heading depth
        while (sectionStack.length >= level) sectionStack.pop();
        sectionStack.push(title);
        elements.push({
          id: nextElementId(),
          kind: 'title',
          text: title,
          level,
          sectionPath: sectionStack.slice(0, -1),
        });
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
        elements.push({
          id: nextElementId(),
          kind: 'list_item',
          text: trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''),
          sectionPath: [...sectionStack],
        });
      } else {
        // Accumulate consecutive non-blank lines into one paragraph
        const last = elements[elements.length - 1];
        if (last?.kind === 'paragraph' && last.sectionPath.join() === sectionStack.join()) {
          last.text += ' ' + trimmed;
        } else {
          elements.push({
            id: nextElementId(),
            kind: 'paragraph',
            text: trimmed,
            sectionPath: [...sectionStack],
          });
        }
      }
    } else {
      if (line.startsWith('```')) {
        const code = fenceLines.join('\n');
        elements.push({
          id:       nextElementId(),
          kind:     'code',
          text:     code,
          markdown: fenceLang ? `\`\`\`${fenceLang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
          sectionPath: [...sectionStack],
        });
        inFence    = false;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
    }
  }

  // Flush unclosed fence
  if (inFence && fenceLines.length > 0) {
    const code = fenceLines.join('\n');
    elements.push({
      id: nextElementId(),
      kind: 'code',
      text: code,
      markdown: `\`\`\`\n${code}\n\`\`\``,
      sectionPath: [...sectionStack],
    });
  }

  return elements;
}
