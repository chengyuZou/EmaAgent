import { open, readFile } from 'node:fs/promises';
import type { ToolInvocation } from '@ema-agent/tools';
import type { CallVision } from '@ema-agent/vision';
import type { PdfBlock } from './pdfParser.js';
import { DEFAULT_PDF_PAGE_COUNT as DEFAULT_PAGE_COUNT, MAX_PDF_BYTES } from './limits.js';

export interface PdfReadWarning {
  page: number;
  code: string;
  message: string;
  retryable: boolean;
}

export interface PdfReadResult {
  type: 'pdf_content';
  filePath: string;
  content: string;
  startPage: number;
  endPage: number;
  totalPages: number;
  nextPage?: number;
  warnings: PdfReadWarning[];
}

export async function readPdfFile(
  input: { readonly fullPath: string; readonly filePath: string; readonly sizeBytes: number; readonly startPage?: number; readonly pageCount?: number },
  vision: CallVision | undefined,
  invocation: ToolInvocation,
): Promise<PdfReadResult> {
  const filePath = input.fullPath;
  invocation.signal.throwIfAborted();

  if (input.sizeBytes > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is too large (${formatMiB(input.sizeBytes)} MiB > ${formatMiB(MAX_PDF_BYTES)} MiB).`,
    );
  }
  await assertPdfSignature(filePath);

  const startPage = input.startPage ?? 1;
  const requestedPageCount = input.pageCount ?? DEFAULT_PAGE_COUNT;
  const requestedEndPage = startPage + requestedPageCount - 1;
  // Vision 绑定用于扫描页 OCR 和图表描述, 未配置时保留文本及缺失内容警告.
  // PDF 解析依赖只在真正读取 PDF 时加载, 普通文本读取不启动 pdfjs.
  const { PdfParser, PdfVisionReader } = await import('./pdfParser.js');
  const imageReader = vision
    ? new PdfVisionReader(vision, invocation.signal)
    : undefined;
  const result = await new PdfParser(imageReader).readRange(
    new Uint8Array(await readFile(filePath, { signal: invocation.signal })),
    {
      startPage,
      endPage: requestedEndPage,
      signal: invocation.signal,
    },
  );

  const totalPages = result.pageCount;
  const endPage = Math.min(requestedEndPage, totalPages);
  const warnings = result.failures.map((failure) => ({
    page: failure.page,
    code: failure.errorCode,
    message: failure.error,
    retryable: failure.retryable,
  }));

  return {
    type: 'pdf_content',
    filePath: input.filePath,
    content: formatPdfBlocks(result.blocks, startPage, endPage),
    startPage,
    endPage,
    totalPages,
    ...(endPage < totalPages ? { nextPage: endPage + 1 } : {}),
    warnings,
  };
}

export function renderPdfContent(output: PdfReadResult): string {
  let content = output.content;
  if (output.warnings.length > 0) {
    const warnings = output.warnings.map(warning => `- 第 ${warning.page} 页: ${warning.message}`);
    content += `\n\n[读取不完整]\n${warnings.join('\n')}`;
  }
  if (output.nextPage !== undefined) {
    content += `\n\nRead start_page=${output.nextPage} to continue (total ${output.totalPages} pages).`;
  }
  return content;
}
async function assertPdfSignature(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || signature.toString('ascii') !== '%PDF-') {
      throw new Error(`File does not contain a valid PDF signature: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

function formatPdfBlocks(
  blocks: readonly PdfBlock[],
  startPage: number,
  endPage: number,
): string {
  const pages = new Map<number, PdfBlock[]>();
  for (const block of blocks) {
    const page = block.page;
    const pageBlocks = pages.get(page) ?? [];
    pageBlocks.push(block);
    pages.set(page, pageBlocks);
  }

  const sections: string[] = [];
  for (let page = startPage; page <= endPage; page++) {
    const body = (pages.get(page) ?? []).map(formatBlock).filter(Boolean).join('\n\n');
    sections.push(`## Page ${page}\n\n${body || '[No readable text on this page]'}`);
  }
  return sections.join('\n\n');
}

function formatBlock(block: PdfBlock): string {
  if (block.markdown?.trim()) return block.markdown.trim();
  switch (block.kind) {
    case 'title':
      return `${'#'.repeat(Math.min(Math.max(block.level ?? 2, 1), 6))} ${block.text}`;
    case 'list_item':
      return `- ${block.text}`;
    default:
      return block.text;
  }
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
