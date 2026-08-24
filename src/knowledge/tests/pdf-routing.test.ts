// 测试 B-074 PDF 三路路由: 纯文本走文本层, 文本+显著图追加 Vision 图表描述(caption),
// 乱码/扫描页降级整页 Vision OCR; 乱码检测覆盖 PUA 码点、子集字体门与代码页误判防护。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DocumentBlock } from '../types.js';
import type { ImageReader } from '../readers/image.js';
import { VisionError } from '@ema-agent/vision';

// pdfjs 在本测试中整体 mock; OPS 值与真实 4.10.x 枚举一致(见 legacy/build/pdf.mjs)。
const { mockGetDocument, OPS } = vi.hoisted(() => ({
  mockGetDocument: vi.fn(),
  OPS: {
    paintImageXObject: 85,
    paintInlineImageXObject: 86,
    paintInlineImageXObjectGroup: 87,
    paintImageXObjectRepeat: 88,
  },
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  OPS,
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

// canvas 原生模块用 stub 替代, renderPageToPng 只关心 getContext/toBuffer。
vi.mock('canvas', () => ({
  createCanvas: () => ({
    getContext: () => ({}),
    toBuffer: () => Buffer.from('fake-png'),
  }),
}));

import { PdfReader, garbledCharRatio, isPageTextGarbled } from '../readers/pdf.js';

interface FakePageSpec {
  text?: string;
  height?: number;
  /** 文本项携带的内部字体 id(对应 commonObjs 里的字体对象)。 */
  fontName?: string;
  ops?: Array<{ fn: number; args: unknown[] }>;
  objs?: Record<string, { width: number; height: number }>;
  /** commonObjs 里的字体对象, name 是原始字体名(子集字体形如 "ABCDEF+RealFont")。 */
  fontObjs?: Record<string, { name: string }>;
}

function fakePage(spec: FakePageSpec) {
  return {
    getTextContent: async () => ({
      items: spec.text
        ? [{ str: spec.text, height: spec.height ?? 12, fontName: spec.fontName }]
        : [],
    }),
    getOperatorList: async () => ({
      fnArray: (spec.ops ?? []).map(op => op.fn),
      argsArray: (spec.ops ?? []).map(op => op.args),
    }),
    getViewport: () => ({ width: 612, height: 792 }),
    render: () => ({ promise: Promise.resolve() }),
    objs: {
      has: (id: string) => Object.hasOwn(spec.objs ?? {}, id),
      get: (id: string) => (spec.objs ?? {})[id],
    },
    commonObjs: {
      has: (id: string) => Object.hasOwn(spec.fontObjs ?? {}, id),
      get: (id: string) => (spec.fontObjs ?? {})[id],
    },
  };
}

function usePdf(pages: Array<ReturnType<typeof fakePage>>) {
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: async (p: number) => pages[p - 1],
    }),
  });
}

/** 非空白字符 >= 30 的真实文本, 保证走"文本层可用"分支。 */
const LONG_TEXT = 'This page has a title and several lines of real explanatory text.';
/** 全 ASCII 标点串: "子集字体 ASCII 化"事故的典型产物(CJK 被错乱映射到标点区)。 */
const PUNCT_ONLY = '!"#%&()*+,-./:;<=>?@[]^_{|}~'.repeat(3);

/** 构造 ImageReader 存根, 记录每次 readWithTask 的 task。 */
function stubImageReader(text = '图表描述: 流程从 A 到 B') {
  const tasks: string[] = [];
  const blocks: DocumentBlock[] = [{ id: 'b1', kind: 'image', text, sectionPath: [] }];
  const reader = {
    read: vi.fn(async () => ({ blocks: blocks.map(b => ({ ...b })) })),
    readWithTask: vi.fn(async (_src: unknown, task: string) => {
      tasks.push(task);
      return { blocks: blocks.map(b => ({ ...b })) };
    }),
  };
  return { reader: reader as unknown as ImageReader, tasks };
}

const SRC = { kind: 'bytes' as const, bytes: new Uint8Array(8), name: 'doc.pdf' };

beforeEach(() => {
  mockGetDocument.mockReset();
});

describe('B-074 PDF 三路路由', () => {
  it('按页范围只解析被请求的页面，同时保留整份文档总页数', async () => {
    usePdf([
      fakePage({ text: `${LONG_TEXT} first` }),
      fakePage({ text: `${LONG_TEXT} second` }),
      fakePage({ text: `${LONG_TEXT} third` }),
    ]);
    const result = await new PdfReader().readRange(SRC, { startPage: 2, endPage: 2 });

    expect(result.pageCount).toBe(3);
    expect(result.blocks).not.toHaveLength(0);
    expect(result.blocks.every((block) => block.page === 2)).toBe(true);
    expect(result.blocks.map((block) => block.text).join(' ')).toContain('second');
    expect(result.blocks.map((block) => block.text).join(' ')).not.toContain('first');
  });

  it('纯文本页只走文本层, 不触发任何 Vision 调用', async () => {
    usePdf([fakePage({ text: LONG_TEXT })]);
    const { reader, tasks } = stubImageReader();
    const result = await new PdfReader(reader).read(SRC);

    expect(result.failures).toEqual([]);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every(b => b.source === 'text-layer')).toBe(true);
    expect(tasks).toEqual([]);
  });

  it('文本+显著图(XObject): 文本保留并追加 caption 图表描述块', async () => {
    usePdf([fakePage({
      text: LONG_TEXT,
      ops: [{ fn: OPS.paintImageXObject, args: ['img1'] }],
      objs: { img1: { width: 800, height: 600 } },
    })]);
    const { reader, tasks } = stubImageReader();
    const result = await new PdfReader(reader).read(SRC);

    const sources = result.blocks.map(b => b.source);
    expect(sources).toContain('text-layer');
    expect(sources).toContain('vision-figure');
    expect(tasks).toEqual(['caption']);
    const fig = result.blocks.find(b => b.source === 'vision-figure')!;
    expect(fig.kind).toBe('image');
    expect(fig.page).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('上一页 Vision 段落不会与下一页文本层续写合并', async () => {
    usePdf([
      fakePage({
        text: LONG_TEXT,
        ops: [{ fn: OPS.paintImageXObject, args: ['img1'] }],
        objs: { img1: { width: 800, height: 600 } },
      }),
      fakePage({ text: 'continues with enough lowercase explanatory text for the second page.' }),
    ]);
    const stub = stubImageReader('figure description without punctuation');
    const result = await new PdfReader(stub.reader).read(SRC);

    const figure = result.blocks.find((block) => block.source === 'vision-figure');
    const secondPageText = result.blocks.find(
      (block) => block.source === 'text-layer' && block.page === 2,
    );
    expect(figure?.text).toBe('figure description without punctuation');
    expect(secondPageText?.text).toContain('continues with enough lowercase');
  });

  it('小图标(20x20)不算显著图, 不触发 caption', async () => {
    usePdf([fakePage({
      text: LONG_TEXT,
      ops: [{ fn: OPS.paintImageXObject, args: ['icon'] }],
      objs: { icon: { width: 20, height: 20 } },
    })]);
    const { reader, tasks } = stubImageReader();
    const result = await new PdfReader(reader).read(SRC);

    expect(result.blocks.every(b => b.source === 'text-layer')).toBe(true);
    expect(tasks).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('内联图像直接用 args 里的尺寸判定显著性', async () => {
    usePdf([fakePage({
      text: LONG_TEXT,
      ops: [{ fn: OPS.paintInlineImageXObject, args: [{ width: 900, height: 700 }] }],
    })]);
    const { reader, tasks } = stubImageReader();
    const result = await new PdfReader(reader).read(SRC);

    expect(tasks).toEqual(['caption']);
    expect(result.blocks.some(b => b.source === 'vision-figure')).toBe(true);
  });

  it('图像尺寸无法解析时保守按有图处理', async () => {
    usePdf([fakePage({
      text: LONG_TEXT,
      ops: [{ fn: OPS.paintImageXObject, args: ['unresolved'] }],
    })]);
    const { reader, tasks } = stubImageReader();
    await new PdfReader(reader).read(SRC);

    expect(tasks).toEqual(['caption']);
  });

  it('PUA 乱码文本层降级到整页 OCR, 不索引乱码', async () => {
    usePdf([fakePage({ text: String.fromCodePoint(0xE000).repeat(40) })]);
    const stub = stubImageReader('OCR 识别出的文字');
    const result = await new PdfReader(stub.reader).read(SRC);

    expect(stub.reader.read).toHaveBeenCalledTimes(1);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every(b => b.source === 'vision-ocr')).toBe(true);
  });

  it('子集字体 ASCII 化的页面降级到整页 OCR', async () => {
    usePdf([fakePage({
      text: PUNCT_ONLY,
      fontName: 'f1',
      fontObjs: { f1: { name: 'ABCDEF+FakeCJK' } },
    })]);
    const stub = stubImageReader('OCR 识别出的文字');
    const result = await new PdfReader(stub.reader).read(SRC);

    expect(stub.reader.read).toHaveBeenCalledTimes(1);
    expect(result.blocks.every(b => b.source === 'vision-ocr')).toBe(true);
  });

  it('标点偏多但字体正常的页面仍走文本层, 不误判乱码', async () => {
    usePdf([fakePage({
      text: PUNCT_ONLY,
      fontName: 'f1',
      fontObjs: { f1: { name: 'Helvetica' } },
    })]);
    const { reader, tasks } = stubImageReader();
    const result = await new PdfReader(reader).read(SRC);

    expect(result.blocks.every(b => b.source === 'text-layer')).toBe(true);
    expect(tasks).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('短文本(扫描页)走整页 OCR, 保持原有行为', async () => {
    usePdf([fakePage({ text: 'Hi' })]);
    const stub = stubImageReader('扫描页文字');
    const result = await new PdfReader(stub.reader).read(SRC);

    expect(stub.reader.read).toHaveBeenCalledTimes(1);
    expect(result.blocks.some(b => b.source === 'vision-ocr')).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('caption 失败时文本块保留且记录失败分片, 不加占位块', async () => {
    usePdf([fakePage({
      text: LONG_TEXT,
      ops: [{ fn: OPS.paintImageXObject, args: ['img1'] }],
      objs: { img1: { width: 800, height: 600 } },
    })]);
    const reader = {
      read: vi.fn(),
      readWithTask: vi.fn(async (): Promise<never> => {
        throw new VisionError('vision/call_failed', 'server boom', 500);
      }),
    } as unknown as ImageReader;
    const result = await new PdfReader(reader).read(SRC);

    expect(result.blocks.every(b => b.source === 'text-layer')).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.errorCode).toBe('vision/call_failed');
    expect(result.failures[0]!.retryable).toBe(true);
  });

  it('未配置 Vision 时含图页记录 kb/pdf-figure-unavailable, 不伪装完整', async () => {
    usePdf([fakePage({
      text: LONG_TEXT,
      ops: [{ fn: OPS.paintImageXObject, args: ['img1'] }],
      objs: { img1: { width: 800, height: 600 } },
    })]);
    const result = await new PdfReader().read(SRC);

    expect(result.blocks.every(b => b.source === 'text-layer')).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.errorCode).toBe('kb/pdf-figure-unavailable');
    expect(result.failures[0]!.retryable).toBe(false);
  });
});

describe('文本层乱码检测', () => {
  it('正常中英文文本不判乱码', () => {
    expect(isPageTextGarbled([{ str: '这是一段正常的中文文本, 包含标点。还需要足够长度。', height: 12 }])).toBe(false);
    expect(isPageTextGarbled([{ str: 'This is normal English text with punctuation, numbers 123 and many more words here.', height: 12 }])).toBe(false);
    expect(garbledCharRatio('hello world')).toBe(0);
  });

  it('PUA/替换符占比过半判乱码', () => {
    const pua = String.fromCodePoint(0xE000);
    expect(garbledCharRatio(pua.repeat(10))).toBe(1);
    expect(isPageTextGarbled([{ str: pua.repeat(30), height: 12 }])).toBe(true);
    expect(garbledCharRatio('正常文本' + pua + '更多正常文本内容')).toBeLessThan(0.5);
  });

  it('无字体信息时退回纯文本统计特征', () => {
    // 全 ASCII 标点、无 CJK、无字母数字, 且无法解析字体名时的兜底判据
    expect(isPageTextGarbled([{ str: PUNCT_ONLY, height: 12 }])).toBe(true);
  });

  it('子集字体门: 子集前缀字体 + ASCII 标点化判乱码', () => {
    const items = [{ str: PUNCT_ONLY, height: 12, fontName: 'f1' }];
    expect(isPageTextGarbled(items, () => 'ABCDEF+FakeCJK')).toBe(true);
  });

  it('子集字体门: 非子集字体不按编码事故处理', () => {
    const items = [{ str: PUNCT_ONLY, height: 12, fontName: 'f1' }];
    expect(isPageTextGarbled(items, () => 'Helvetica')).toBe(false);
  });

  it('代码页不误判: 字母数字占比高(即使嵌入子集字体)', () => {
    const code = 'const x = (a, b) => a[b] + c.d(e); if (x) { return y[0]; } // comment';
    expect(isPageTextGarbled([{ str: code, height: 12 }])).toBe(false);
    expect(isPageTextGarbled([{ str: code, height: 12, fontName: 'f1' }], () => 'ABCDEF+Mono')).toBe(false);
  });
});
