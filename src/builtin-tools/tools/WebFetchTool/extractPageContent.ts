import { Readability } from '@mozilla/readability';
import { load, type CheerioAPI } from 'cheerio';
import { JSDOM } from 'jsdom';
import { htmlToMarkdown } from './htmlToMarkdown.js';

// 与 Readability 的默认文章长度一致. 更短的角色介绍/FAQ 直接保留主体, 不让文章规则改写标题.
const ARTICLE_MIN_CHARACTERS = 500;

export async function extractPageContent(
  body: Buffer,
  contentType: string,
  finalUrl: string,
  raw: boolean,
): Promise<string> {
  const mimeType = contentType.split(';')[0]!.trim().toLowerCase();
  const isHtml = mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
  const text = decodeText(body, contentType, isHtml);
  // 原始文本不重新序列化, 否则排查页面时看到的就不再是服务端返回的标签与排版.
  if (raw || !isHtml) {
    return text;
  }
  return htmlToMarkdown(extractHtmlBody(text, finalUrl));
}

function decodeText(body: Buffer, contentType: string, isHtml: boolean): string {
  let charset: string | undefined;
  // BOM 优先于 HTTP 声明, 与浏览器读取这些文本编码时的顺序一致.
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    charset = 'utf-8';
  } else if (body[0] === 0xff && body[1] === 0xfe) {
    charset = 'utf-16le';
  } else if (body[0] === 0xfe && body[1] === 0xff) {
    charset = 'utf-16be';
  } else {
    charset = readCharset(contentType);
  }

  if (!charset && isHtml) {
    // HTML 的编码声明应在开头 1024 字节内. 编码名是 ASCII, 此处只解析声明, 不解码正文.
    const header = load(body.subarray(0, 1024).toString('latin1'));
    for (const element of header('meta').toArray()) {
      const meta = header(element);
      charset = meta.attr('charset');
      if (!charset && meta.attr('http-equiv')?.toLowerCase() === 'content-type') {
        charset = readCharset(meta.attr('content') ?? '');
      }
      if (charset) {
        break;
      }
    }
  }

  try {
    // 编码转换由 Node 的 TextDecoder 完成, 不自行维护字符映射表.
    return new TextDecoder(charset?.trim() || 'utf-8').decode(body);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`不支持网页声明的文本编码: ${charset}`, { cause: error });
    }
    throw error;
  }
}

function readCharset(contentType: string): string | undefined {
  const match = /\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(contentType);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function extractHtmlBody(html: string, finalUrl: string): string {
  const page = load(html);
  let baseUrl = finalUrl;
  const declaredBase = page('base[href]').first().attr('href');
  if (declaredBase) {
    try {
      baseUrl = new URL(declaredBase, finalUrl).toString();
    } catch {
      // 无效的 base 声明不改变文档地址, 相对链接仍按最终请求地址处理.
    }
  }

  page('script, style, template, noscript, iframe, object, embed, nav, [role="navigation"], [hidden], [aria-hidden="true"]').remove();
  // 不删除正文内部的 header/aside, 它们可能是标题、文档警告或补充说明.
  page('body > header, body > footer, body > aside').remove();
  for (const element of page('pre').toArray()) {
    const block = page(element);
    // HTML 允许 pre 直接放文本. Turndown 只对 pre > code 生成代码块, 补结构但不改变文本与空白.
    if (block.children('code').length === 0) {
      block.wrapInner('<code></code>');
    }
  }
  for (const attribute of ['href', 'src']) {
    for (const element of page(`[${attribute}]`).toArray()) {
      const node = page(element);
      const value = node.attr(attribute)!;
      try {
        node.attr(attribute, new URL(value, baseUrl).toString());
      } catch {
        // 网页自身的无效链接不能让整页正文读取失败.
      }
    }
  }

  const main = page('main, [role="main"]').first();
  const explicitBody = main.length > 0 ? main : page('article').first();
  const body = explicitBody.length > 0 ? explicitBody : page('body');
  const codeBlockCount = body.find('pre').length;
  const tableCount = body.find('table').length;
  const structuredBody = explicitBody.length > 0 && (codeBlockCount > 0 || tableCount > 0);
  let selected: CheerioAPI;
  let title = page('title').text().trim();

  if (structuredBody || body.text().trim().length < ARTICLE_MIN_CHARACTERS) {
    // 文档的代码和参数表不是文章段落; 短介绍也不适合文章规则. 这些页面直接保留主体结构.
    selected = load(body.html() ?? '');
  } else {
    // 默认不执行脚本或下载图片等资源. Readability 会修改 DOM, 回退时使用 Cheerio 保留的正文.
    const dom = new JSDOM(page.html(), { url: finalUrl });
    try {
      const article = new Readability(dom.window.document, { charThreshold: ARTICLE_MIN_CHARACTERS }).parse();
      if (article?.content) {
        const extracted = load(article.content);
        // 没有明确主体的文档也可以提取, 但不能以丢掉代码或表格为代价去掉菜单.
        const droppedStructure = extracted('pre').length < codeBlockCount
          || extracted('table').length < tableCount;
        if (droppedStructure) {
          selected = load(body.html() ?? '');
        } else {
          selected = extracted;
          title = article.title?.trim() || title;
        }
      } else {
        selected = load(body.html() ?? '');
      }
    } finally {
      dom.window.close();
    }
  }

  if (!selected('body').text().trim()) {
    throw new Error('没有读到静态正文, 页面可能需要 JavaScript 或登录. 可在内置浏览器中查看');
  }
  if (title && selected('h1').length === 0) {
    selected('body').prepend(selected('<h1>').text(title));
  }
  return selected('body').html() ?? '';
}
