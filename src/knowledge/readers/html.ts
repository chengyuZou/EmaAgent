import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';

export class HtmlReader implements DocumentReader {
  async read(source: ReaderSource): Promise<ReadResult> {
    const html = source.kind === 'path'
      ? await readFile(source.path, 'utf8')
      : new TextDecoder().decode(source.bytes);
    return { blocks: parseHtml(html) };
  }
}

export function parseHtml(html: string): DocumentBlock[] {
  const $ = load(html);
  const blocks: DocumentBlock[] = [];
  const stack: string[] = [];

  $('script, style, nav, footer, header').remove();

  $('body, main, article').first().find(
    'h1,h2,h3,h4,h5,h6,p,li,pre,table,img,figure,figcaption',
  ).each((_i, node): void => {
    const el  = $(node);
    const tag = node.type === 'tag' ? (node as { name: string }).name.toLowerCase() : '';
    const txt = el.text().trim();
    if (!txt && tag !== 'img') return;

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]!, 10);
      while (stack.length >= level) stack.pop();
      stack.push(txt);
      blocks.push({ id: nextBlockId(), kind: 'title', text: txt, level, sectionPath: stack.slice(0, -1) });
      return;
    }
    if (tag === 'p')          { if (txt) blocks.push({ id: nextBlockId(), kind: 'paragraph', text: txt, sectionPath: [...stack] }); return; }
    if (tag === 'li')         { blocks.push({ id: nextBlockId(), kind: 'list_item', text: txt, sectionPath: [...stack] }); return; }
    if (tag === 'figcaption') { blocks.push({ id: nextBlockId(), kind: 'caption',   text: txt, sectionPath: [...stack] }); return; }
    if (tag === 'img') {
      const alt = el.attr('alt')?.trim() ?? '';
      if (alt) blocks.push({ id: nextBlockId(), kind: 'image', text: alt, sectionPath: [...stack] });
      return;
    }
    if (tag === 'pre') {
      const code = el.find('code').text() || txt;
      const lang = el.find('code').attr('class')?.match(/language-(\w+)/)?.[1] ?? '';
      blocks.push({ id: nextBlockId(), kind: 'code', text: code,
        markdown: lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
        sectionPath: [...stack] });
      return;
    }
    if (tag === 'table') {
      blocks.push({ id: nextBlockId(), kind: 'table', text: txt, markdown: tableToMarkdown($, node), sectionPath: [...stack] });
    }
  });

  return blocks;
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
  const body   = rows.slice(1);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
}
