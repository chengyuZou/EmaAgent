// 把 PDF 逐页拆成文字块: 文字清晰的页直接用文字层, 带图表的页请 AI 补一段图表描述,
// 乱码或扫描页整页请 AI 重新识字。位于知识库 readers 层, 是文档入库(ingest)的第一步。

import { readFile } from 'node:fs/promises';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadFailure, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';
import type { ImageReader } from './image.js';
import { isKbVisionAdapterError } from '../adapters/vision.js';

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Resolve the worker from the installed package so the path is correct regardless
// of how this module is bundled or run (tsx, Node, compiled).
const _require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  _require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const HEADING_SCALE = 1.25;
// A page whose text layer has fewer than this many non-space chars is treated as
// image-only (scanned) and routed to OCR. Decided PER PAGE so mixed documents
// (some digital pages, some scanned) don't silently lose the scanned pages.
const MIN_PAGE_TEXT_CHARS = 30;
// Render scale for OCR rasterization — higher = better OCR, slower.
const OCR_RENDER_SCALE = 2.0;
// 单张图像面积达到该像素值才视为"显著图"(约 224x224): 滤掉图标/项目符号/页眉
// logo, 避免给每张装饰性小图都烧一次 Vision 调用; 真正的图表/截图/流程图都远大于此。
const MIN_SIGNIFICANT_IMAGE_PIXELS = 50_000;
// 文本层乱码率(私有区/未映射码点占比)达到该值时不再信任文本层。
const GARBLED_RATIO_THRESHOLD = 0.5;

// 图像绘制算子集合按 pdfjs 版本防御式构建: 只收集当前版本实际定义的 op id
// (v4 已把 paintJpegXObject 合并进 paintImageXObject, 老版本的 id 可能不存在)。
// 掩码类算子(paintImageMask*)是模板小图, 不参与显著图判断。
const OPS_MAP: Record<string, number | undefined> = pdfjs.OPS;
const IMAGE_OPS = new Set<number>(
  [
    'paintImageXObject',
    'paintJpegXObject',
    'paintInlineImageXObject',
    'paintInlineImageXObjectGroup',
    'paintImageXObjectRepeat',
  ]
    .map(name => OPS_MAP[name])
    .filter((op): op is number => typeof op === 'number'),
);
// 内联图像算子: 图像数据直接挂在 args 上, 不需要回 page.objs 解析。
const INLINE_IMAGE_OPS = new Set<number>(
  ['paintInlineImageXObject', 'paintInlineImageXObjectGroup']
    .map(name => OPS_MAP[name])
    .filter((op): op is number => typeof op === 'number'),
);

// 乱码字符: 私有使用区(BMP + 两个补充平面), U+FFFD 替换符, 非常用控制符,
// 未分配/代理区码点。判定范围对齐 RAGFlow 的 _is_garbled_char。
const GARBLED_CHAR_RE =
  /[\uE000-\uF8FF\uFFFD\u0080-\u009F\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\p{Cn}\p{Cs}]|[\u{F0000}-\u{FFFFF}]|[\u{100000}-\u{10FFFF}]/u;
const WHITESPACE_RE = /\s/;
// CJK/假名/谚文码点范围, 用于识别"中文文档被错乱映射成全 ASCII"的字体编码事故。
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u3040-\u30FF]|[\u{20000}-\u{2FA1F}]/u;
const ASCII_PUNCT_RE = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/;
const ASCII_ALNUM_RE = /[A-Za-z0-9]/;

export interface PdfItem { str: string; height: number; fontName?: string }

/** pdfjs 页面上本文件用到的最小结构(算子表 + 图像对象存储)。 */
interface PdfPageOps {
  getOperatorList: () => Promise<{
    fnArray: ArrayLike<number>;
    argsArray: ArrayLike<unknown[]>;
  }>;
  objs:       { has(id: string): boolean; get(id: string): unknown };
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

/** 文本的乱码字符占比(忽略空白; 空文本返回 0)。 */
export function garbledCharRatio(text: string): number {
  let total = 0;
  let garbled = 0;
  for (const ch of text) {
    if (WHITESPACE_RE.test(ch)) continue;
    total++;
    if (GARBLED_CHAR_RE.test(ch)) garbled++;
  }
  return total === 0 ? 0 : garbled / total;
}

// 子集字体名前缀: PDF 子集嵌入字体的名字形如 "ABCDEF+RealFont"(2~6 位大写tag+加号)。
const SUBSET_FONT_PREFIX_RE = /^[A-Z0-9]{2,6}\+/;

/**
 * 判定整页文本层是否因字体编码错乱而不可用。判据分两层:
 * 1) 乱码码点占比 >= 阈值(私有区/替换符, pdfjs 对无 ToUnicode 字体的典型输出);
 * 2) "子集字体 ASCII 化"(CJK 被映射到 ASCII 标点区), 对齐 RAGFlow 的
 *    _is_garbled_by_font_encoding: 子集字体字符占比 >= 0.3 + 几乎无 CJK +
 *    标点占比 > 0.4; 另加字母数字下限保护代码/公式页(代码字母多, 编码垃圾字母少)。
 *    pdfjs 文本项只带内部字体 id, 原始字体名需经 commonObjs/objs 再解析一层;
 *    一个字体都解析不出来时退回纯文本统计(字体门缺失的兜底, 已在上文声明)。
 * 误判代价不对称: 误判为乱码最多给该页多烧一次 Vision 调用,
 * 漏判则会把乱码文本嵌进向量库污染检索, 所以阈值偏敏感方向调。
 */
export function isPageTextGarbled(
  items: PdfItem[],
  resolveFont?: (fontId: string) => string | undefined,
): boolean {
  const joined = items.map(it => it.str).join('');
  if (garbledCharRatio(joined) >= GARBLED_RATIO_THRESHOLD) return true;

  // 按字体 id 去重解析子集前缀(同页同一字体会出现在大量文本项上)。
  const subsetByFont = new Map<string, boolean>();
  if (resolveFont) {
    for (const it of items) {
      if (!it.fontName || subsetByFont.has(it.fontName)) continue;
      const name = resolveFont(it.fontName);
      if (name) subsetByFont.set(it.fontName, SUBSET_FONT_PREFIX_RE.test(name));
    }
  }

  let total = 0;
  let cjk = 0;
  let punct = 0;
  let alnum = 0;
  let subsetChars = 0;
  for (const it of items) {
    const fromSubsetFont = it.fontName !== undefined && subsetByFont.get(it.fontName) === true;
    for (const ch of it.str) {
      if (WHITESPACE_RE.test(ch)) continue;
      total++;
      if (fromSubsetFont) subsetChars++;
      if (CJK_RE.test(ch)) cjk++;
      else if (ASCII_PUNCT_RE.test(ch)) punct++;
      else if (ASCII_ALNUM_RE.test(ch)) alnum++;
    }
  }
  if (total < 20) return false;

  const mangledStats =
    cjk / total < 0.05 && punct / total > 0.4 && alnum / total < 0.3;
  if (subsetByFont.size === 0) return mangledStats;
  return mangledStats && subsetChars / total >= 0.3;
}

/** 从 commonObjs/objs 解析字体原始名(形如 "ABCDEF+RealFont"); 未加载或无名返回 undefined。 */
function resolveOriginalFontName(page: PdfPageOps, fontId: string): string | undefined {
  for (const store of [page.commonObjs, page.objs]) {
    if (!store.has(fontId)) continue;
    try {
      const font = store.get(fontId) as { name?: unknown } | undefined;
      if (font && typeof font.name === 'string' && font.name.length > 0) return font.name;
    } catch {
      // 对象未解析完成时 get 会抛错, 当作不可用继续找下一个存储。
    }
  }
  return undefined;
}

export class PdfReader implements DocumentReader {
  /**
   * @param imageReader Optional vision-backed OCR reader. When provided, pages
   *   without a usable text layer are rasterized and OCR'd. When absent, such
   *   pages emit a placeholder block (legacy behaviour) instead of being dropped.
   */
  constructor(private readonly imageReader?: ImageReader) {}

  async read(source: ReaderSource): Promise<ReadResult> {
    const data = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const pdf       = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const blocks:   DocumentBlock[] = [];
    const failures: ReadFailure[] = [];
    const stack:    string[] = [];
    const pageCount = pdf.numPages;

    for (let p = 1; p <= pageCount; p++) {
      // Per-page isolation: one broken/unrenderable page must not abort the whole
      // document (handles truncated/corrupt PDFs — 缺页/断页).
      let page;
      try {
        page = await pdf.getPage(p);
      } catch (error) {
        blocks.push(brokenPageBlock(p));
        failures.push(pageFailure(p, 'kb/pdf-page-unreadable', false, error));
        continue;
      }

      let items: PdfItem[] = [];
      let textLayerError: unknown;
      try {
        const content = await page.getTextContent();
        items = content.items
          .filter((it): it is typeof it & { str: string } => 'str' in it)
          .map(it => ({
            str:      (it as { str: string }).str,
            height:   (it as { height?: number }).height ?? 0,
            fontName: (it as { fontName?: string }).fontName,
          }));
      } catch (error) {
        items = [];
        textLayerError = error;
      }

      const pageTextLen = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
      // 文本层可用性的两个维度: 长度够 + 不是乱码。乱码页(烂编码字体)与扫描页
      // 一样降级到整页 OCR, 不把乱码文本写进知识库(B-074 同源修复)。
      const textUsable =
        pageTextLen >= MIN_PAGE_TEXT_CHARS &&
        !isPageTextGarbled(
          items,
          fontId => resolveOriginalFontName(page as unknown as PdfPageOps, fontId),
        );

      // ── 文本层可用: 先用文本层; 页面含显著图时追加 Vision 读图 ────────────
      if (textUsable) {
        const median   = medianHeight(items);
        const pageBlks = itemsToBlocks(items, median, p, stack);
        for (const b of pageBlks) b.source = 'text-layer';
        mergeContinuation(blocks, pageBlks);

        // 文本够不代表没图: 标题+几行说明+一张核心图表的页, 只索引文字会丢掉图。
        // 图像存在性用页面算子表判断(零重渲染成本), 不再拿文本长度当代理。
        const figurePresent = await pageHasSignificantImage(page as unknown as PdfPageOps);
        if (figurePresent && this.imageReader) {
          await this.appendFigureDescription(page as unknown as RenderablePage, p, blocks, failures, stack);
        } else if (figurePresent) {
          // 未配置 Vision 时诚实记账: 图存在但没解析, 不伪装成完整处理。
          failures.push(pageFailure(
            p,
            'kb/pdf-figure-unavailable',
            false,
            new Error('页面包含图像但未配置 Vision 能力, 图表内容未解析'),
          ));
        }
        continue;
      }

      // ── 扫描页/乱码页: 整页光栅化 Vision OCR ─────────────────────────────
      if (this.imageReader) {
        try {
          const png = await renderPageToPng(page as unknown as RenderablePage, OCR_RENDER_SCALE);
          if (png) {
            const res = await this.imageReader.read({ kind: 'bytes', bytes: png, name: `page-${p}.png` });
            const ocrBlks = res.blocks
              .filter(b => b.text.trim())
              .map(b => ({ ...b, id: nextBlockId(), page: p, source: 'vision-ocr' as const, sectionPath: [...stack] }));
            if (ocrBlks.length > 0) { blocks.push(...ocrBlks); continue; }
          }
          blocks.push(scannedPlaceholder(p));
          failures.push(pageFailure(
            p,
            'kb/pdf-ocr-empty',
            true,
            textLayerError ?? new Error('OCR 未返回可索引文本'),
          ));
        } catch (error) {
          if (isKbVisionAdapterError(error) && error.code === 'vision/aborted') throw error;
          // 单页失败不终止其他页面，但必须写入持久失败分片，不能伪装成完整成功。
          blocks.push(scannedPlaceholder(p));
          failures.push(pageFailure(
            p,
            isKbVisionAdapterError(error) ? error.code : 'kb/pdf-ocr-failed',
            isKbVisionAdapterError(error) ? error.retryable : true,
            error,
          ));
        }
        continue;
      }

      // No OCR capability: keep a placeholder so the page isn't silently dropped.
      blocks.push(scannedPlaceholder(p));
      failures.push(pageFailure(
        p,
        'kb/pdf-ocr-unavailable',
        false,
        textLayerError ?? new Error('当前未配置 PDF OCR 能力'),
      ));
    }

    return { blocks, pageCount, failures };
  }

  /**
   * 给"文本层可用但含显著图"的页追加 Vision 图表描述块(B-074 中间路)。
   * 失败只记失败分片, 不动已落袋的文本块; 描述块追加在本页文本之后,
   * page 标号保留位置信息(caption 任务不带 bbox, 不恢复图在页内的行内位置)。
   */
  private async appendFigureDescription(
    page: RenderablePage,
    p: number,
    blocks: DocumentBlock[],
    failures: ReadFailure[],
    stack: string[],
  ): Promise<void> {
    if (!this.imageReader) return;
    try {
      const png = await renderPageToPng(page, OCR_RENDER_SCALE);
      if (png) {
        const res = await this.imageReader.readWithTask(
          { kind: 'bytes', bytes: png, name: `page-${p}.png` },
          'caption',
        );
        const figBlks = res.blocks
          .filter(b => b.text.trim())
          .map(b => ({ ...b, id: nextBlockId(), page: p, source: 'vision-figure' as const, sectionPath: [...stack] }));
        if (figBlks.length > 0) {
          blocks.push(...figBlks);
          return;
        }
      }
      failures.push(pageFailure(
        p,
        'kb/pdf-figure-empty',
        true,
        new Error('Vision 未返回可用的图表描述'),
      ));
    } catch (error) {
      if (isKbVisionAdapterError(error) && error.code === 'vision/aborted') throw error;
      failures.push(pageFailure(
        p,
        isKbVisionAdapterError(error) ? error.code : 'kb/pdf-figure-failed',
        isKbVisionAdapterError(error) ? error.retryable : true,
        error,
      ));
    }
  }
}

// ── Page image detection (operator-list based, no rasterization) ───────────────

/**
 * 用页面算子表判断本页是否存在"显著图"。只解析不重渲染, 每页一次遍历。
 * 已知盲区: 纯矢量绘制的图表(只有 path 算子没有图像算子)检测不到,
 * 留待 V1.5 本地版面模型收口(见 Emabug B-074 本地 YOLO 评估)。
 */
async function pageHasSignificantImage(page: PdfPageOps): Promise<boolean> {
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch {
    // 算子表解析失败时图像信号缺失, 本页文本已在处理, 静默跳过不额外记账。
    return false;
  }
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]!;
    if (!IMAGE_OPS.has(fn)) continue;
    const dims = INLINE_IMAGE_OPS.has(fn)
      ? readImageDims(opList.argsArray[i]?.[0])
      : readXObjectDims(page, opList.argsArray[i]?.[0]);
    // 尺寸解析不出来时保守按有图处理: 最多多烧一次 Vision 调用, 好过漏掉真正的图。
    if (!dims) return true;
    if (dims.width * dims.height >= MIN_SIGNIFICANT_IMAGE_PIXELS) return true;
  }
  return false;
}

/** 从 page.objs/commonObjs 解析 XObject 图像的像素尺寸; 未解析完成返回 undefined。 */
function readXObjectDims(
  page: PdfPageOps,
  objId: unknown,
): { width: number; height: number } | undefined {
  if (typeof objId !== 'string') return undefined;
  const store = page.objs.has(objId)
    ? page.objs
    : page.commonObjs.has(objId)
      ? page.commonObjs
      : undefined;
  if (!store) return undefined;
  try {
    return readImageDims(store.get(objId));
  } catch {
    return undefined;
  }
}

function readImageDims(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const w = (value as { width?: unknown }).width;
  const h = (value as { height?: unknown }).height;
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return undefined;
  return { width: w, height: h };
}

// ── Cross-page paragraph continuation merge ─────────────────────────────────────

function mergeContinuation(blocks: DocumentBlock[], pageBlks: DocumentBlock[]): void {
  if (blocks.length > 0 && pageBlks.length > 0) {
    const last  = blocks[blocks.length - 1]!;
    const first = pageBlks[0]!;
    if (last.kind === 'paragraph' && first.kind === 'paragraph' &&
        !endsWithPunct(last.text) && looksLikeContinuation(first.text)) {
      last.text = last.text.trimEnd() + ' ' + first.text.trimStart();
      blocks.push(...pageBlks.slice(1));
      return;
    }
  }
  blocks.push(...pageBlks);
}

// ── Page rasterization (for OCR) ────────────────────────────────────────────────

interface RenderablePage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: unknown) => { promise: Promise<void> };
}

async function renderPageToPng(page: RenderablePage, scale: number): Promise<Uint8Array | undefined> {
  try {
    const { createCanvas } = await import('canvas');
    const vp     = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport: vp,
    }).promise;
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    // `canvas` native module unavailable or render failed — caller falls back.
    return undefined;
  }
}

function scannedPlaceholder(page: number): DocumentBlock {
  return { id: nextBlockId(), kind: 'image', text: `[Scanned page ${page} — OCR unavailable]`, page, sectionPath: [] };
}
function brokenPageBlock(page: number): DocumentBlock {
  return { id: nextBlockId(), kind: 'image', text: `[Page ${page} could not be read]`, page, sectionPath: [] };
}

function pageFailure(
  page: number,
  errorCode: string,
  retryable: boolean,
  error: unknown,
): ReadFailure {
  return {
    shardKey: `parse:page:${page}`,
    itemIds: [String(page)],
    retryable,
    errorCode,
    error: error instanceof Error ? error.message : String(error),
  };
}

// ── Text-layer → blocks ─────────────────────────────────────────────────────────

function medianHeight(items: PdfItem[]): number {
  const hs = items.map(it => it.height).filter(h => h > 0).sort((a, b) => a - b);
  return hs.length === 0 ? 12 : hs[Math.floor(hs.length / 2)]!;
}

function itemsToBlocks(items: PdfItem[], median: number, page: number, stack: string[]): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let buf = '', bufH = 0;

  const flush = (): void => {
    const text = buf.trim();
    buf = '';
    if (!text) return;
    if (bufH > median * HEADING_SCALE) {
      const level = hToLevel(bufH, median);
      while (stack.length >= level) stack.pop();
      stack.push(text);
      blocks.push({ id: nextBlockId(), kind: 'title', text, level, page, sectionPath: stack.slice(0, -1) });
    } else {
      const isList = /^[•\-–*]\s/.test(text) || /^\d+[.)]\s/.test(text);
      blocks.push({ id: nextBlockId(), kind: isList ? 'list_item' : 'paragraph',
        text: isList ? text.replace(/^[•\-–*\d.)\s]+/, '').trim() : text,
        page, sectionPath: [...stack] });
    }
  };

  for (const item of items) {
    if (!item.str.trim() && buf) { flush(); continue; }
    if (buf && item.height > 0 && Math.abs(item.height - bufH) > 1) flush();
    if (item.str.trim()) { buf += (buf ? ' ' : '') + item.str.trim(); bufH = item.height || bufH; }
  }
  flush();
  return blocks;
}

function hToLevel(h: number, median: number): number {
  const r = h / median;
  if (r >= 2.0) return 1; if (r >= 1.6) return 2; if (r >= 1.3) return 3; return 4;
}
function endsWithPunct(t: string): boolean { return /[.!?。！？;；:：]\s*$/.test(t.trimEnd()); }
function looksLikeContinuation(t: string): boolean {
  t = t.trimStart();
  if (!t) return false;
  if (/^[a-z]/.test(t)) return true;
  return /^(though|however|and|or|but|which|that|where|when|while|as|if|since|because|therefore|thus|hence|so|yet|nor|for|although|whereas|unless|until|after|before|once|provided|given)\b/i.test(t);
}
