import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Element } from '../types.js';
import type { DocumentReader, ReaderSource } from './base.js';
import { nextElementId } from './base.js';
import { readFile } from 'node:fs/promises';

/**
 * Parses HTML into typed elements.
 * Heading tags → title, p → paragraph, li → list_item,
 * pre/code → code, table → table, img → image (alt as text).
 */
export class HtmlReader implements DocumentReader {
  async read(source: ReaderSource): Promise<Element[]> {
    const html = source.kind === 'path'
      ? await readFile(source.path, 'utf8')
      : new TextDecoder().decode(source.bytes);
    return parseHtml(html);
  }
}

export function parseHtml(html: string): Element[] {
  const $ = load(html);
  const elements: Element[] = [];
  const sectionStack: string[] = [];

  // Remove script/style noise
  $('script, style, nav, footer, header').remove();

  $('body, main, article').first().find(
    'h1,h2,h3,h4,h5,h6,p,li,pre,table,img,figure,figcaption',
  ).each((_i, node): void => {
    const el   = $(node);
    const tag  = node.type === 'tag' ? (node as { name: string }).name.toLowerCase() : '';
    const text = el.text().trim();

    if (!text && tag !== 'img') return;

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]!, 10);
      while (sectionStack.length >= level) sectionStack.pop();
      sectionStack.push(text);
      elements.push({
        id: nextElementId(),
        kind: 'title',
        text,
        level,
        sectionPath: sectionStack.slice(0, -1),
      });
      return;
    }

    if (tag === 'p') {
      if (!text) return;
      elements.push({ id: nextElementId(), kind: 'paragraph', text, sectionPath: [...sectionStack] });
      return;
    }

    if (tag === 'li') {
      elements.push({ id: nextElementId(), kind: 'list_item', text, sectionPath: [...sectionStack] });
      return;
    }

    if (tag === 'pre') {
      const code = el.find('code').text() || text;
      const lang = el.find('code').attr('class')?.match(/language-(\w+)/)?.[1] ?? '';
      elements.push({
        id:       nextElementId(),
        kind:     'code',
        text:     code,
        markdown: lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
        sectionPath: [...sectionStack],
      });
      return;
    }

    if (tag === 'table') {
      const md = tableToMarkdown($, node);
      elements.push({
        id:       nextElementId(),
        kind:     'table',
        text,
        markdown: md,
        sectionPath: [...sectionStack],
      });
      return;
    }

    if (tag === 'img') {
      const alt = el.attr('alt')?.trim() ?? '';
      if (alt) {
        elements.push({ id: nextElementId(), kind: 'image', text: alt, sectionPath: [...sectionStack] });
      }
      return;
    }

    if (tag === 'figcaption') {
      elements.push({ id: nextElementId(), kind: 'caption', text, sectionPath: [...sectionStack] });
    }
  });

  return elements;
}

function tableToMarkdown($: ReturnType<typeof load>, table: AnyNode): string {
  const rows: string[][] = [];
  $(table).find('tr').each((_i, tr): void => {
    const cells: string[] = [];
    $(tr).find('th,td').each((_j, td): void => { cells.push($(td).text().trim()); });
    if (cells.length) rows.push(cells);
  });
  if (rows.length === 0) return '';

  const header = rows[0]!;
  const sep    = header.map(() => '---');
  const body   = rows.slice(1);

  return [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
}
