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

  // 必须先于遍历剔除 chrome——nav/footer/header 是站点外壳 混入正文会污染分块
  // script/style 无文本价值.若不先移除，它们会以段落/列表形式漏进来
  $('script, style, nav, footer, header').remove();

  // 只遍历 body/main/article 中第一个内容容器，防多容器页面重复产出；
  // 选择器只列语义化标签——div/span/section 等结构性标签不产出块（无正文语义）；
  // figure 自身无产出分支，仅保证其 figcaption/img 子节点被遍历到。
  // each 按文档序遍历，保证块序 = 阅读序（chunker 按此顺序分块并做 overlap 前置）。
  $('body, main, article').first().find(
    'h1,h2,h3,h4,h5,h6,p,li,pre,table,img,figure,figcaption',
  ).each((_i, node): void => {
    const el  = $(node);
    const tag = node.type === 'tag' ? (node as { name: string }).name.toLowerCase() : '';
    // 所有文本统一 trim；img 是唯一例外——图片无文本，靠 alt 兜底，空 alt 也会被跳过。
    const txt = el.text().trim();
    if (!txt && tag !== 'img') return;

    // ── 标题：维护章节面包屑栈 ─────────────────────────────────────────────
    // 栈式不变量：HTML 标题按层级嵌套——遇到 level 先弹掉所有 >= level 的祖先
    // （新 h2 到来时旧 h3/h4 必须出栈），再压入自身，栈内容才是真正的祖先链。
    // sectionPath 存"去掉自身"的浅拷贝，后续标题改动栈不影响已产出的块。
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]!, 10);
      while (stack.length >= level) stack.pop();
      stack.push(txt);
      blocks.push({ id: nextBlockId(), kind: 'title', text: txt, level, sectionPath: stack.slice(0, -1) });
      return;
    }
    // ── 正文块：sectionPath 必须取栈的拷贝（[...stack]），不能引用——
    //    后续标题分支会继续改栈，引用会随栈变化而漂移。
    if (tag === 'p')          { if (txt) blocks.push({ id: nextBlockId(), kind: 'paragraph', text: txt, sectionPath: [...stack] }); return; }
    if (tag === 'li')         { blocks.push({ id: nextBlockId(), kind: 'list_item', text: txt, sectionPath: [...stack] }); return; }
    if (tag === 'figcaption') { blocks.push({ id: nextBlockId(), kind: 'caption',   text: txt, sectionPath: [...stack] }); return; }
    // 图片块：以 alt 文本承载（无 alt 则整体丢弃，避免无信息图片进分块）。
    if (tag === 'img') {
      const alt = el.attr('alt')?.trim() ?? '';
      if (alt) blocks.push({ id: nextBlockId(), kind: 'image', text: alt, sectionPath: [...stack] });
      return;
    }
    // 代码块：优先取内层 <code> 文本（<pre> 包裹的才是代码），语言从
    // class="language-xxx" 提取，拼成带围栏的 markdown 便于下游渲染。
    if (tag === 'pre') {
      const code = el.find('code').text() || txt;
      const lang = el.find('code').attr('class')?.match(/language-(\w+)/)?.[1] ?? '';
      blocks.push({ id: nextBlockId(), kind: 'code', text: code,
        markdown: lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
        sectionPath: [...stack] });
      return;
    }
    // 表格：正文保留纯文本（方便检索），markdown 存 GFM 管道表（方便展示）。
    if (tag === 'table') {
      blocks.push({ id: nextBlockId(), kind: 'table', text: txt, markdown: tableToMarkdown($, node), sectionPath: [...stack] });
    }
  });

  return blocks;
}

// 表格转 GFM 管道表：首行作表头 + '---' 分隔行；无单元格文本的行跳过；
// 无任何有效行时返回 ''（table 块此时 text 也为空，属可接受的边缘）。
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
