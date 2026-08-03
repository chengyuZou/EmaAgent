// 按有限页范围读取 PDF 文本层，并明确报告扫描页和图表未解析等不完整结果。
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PdfReader, type DocumentBlock } from '@ema-agent/knowledge';
import { buildTool, contextFail, contextOk, type BuiltinToolContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { isBlockedDevice } from '../FileReadTool/FileReadTool.js';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const DEFAULT_PAGE_COUNT = 10;
const MAX_PAGE_COUNT = 20;
const MAX_RESULT_BYTES = 50 * 1024;

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute or workspace-relative path to the PDF file.'),
  start_page: z.number().int().min(1).optional().describe('1-based first page to read.'),
  page_count: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_COUNT)
    .optional()
    .describe(`Number of pages to read, capped at ${MAX_PAGE_COUNT}.`),
});

type PdfReadInput = z.infer<typeof inputSchema>;

interface PdfReadToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

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

export const PdfReadTool = buildTool<
  PdfReadInput,
  PdfReadResult,
  BuiltinToolContext,
  PdfReadToolContext
>({
  id: BuiltinTools.PdfRead.id,
  name: BuiltinTools.PdfRead.name,
  description: `Read text and structure from a PDF file.

- Reads ${DEFAULT_PAGE_COUNT} pages by default and at most ${MAX_PAGE_COUNT} pages per call.
- Use start_page to continue from nextPage.
- Text-layer pages are returned directly. Scanned pages and unparsed figures are reported as warnings instead of being silently omitted.
- This tool reads PDF only; use format-specific tools for DOCX, spreadsheets, or presentations.`,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultBytes: MAX_RESULT_BYTES,
  requires: ['workspaceRoot'],

  validateContext(context) {
    if (!context.workspaceRoot) {
      return contextFail('PDF 读取工具未装配工作区。');
    }
    return contextOk({
      workspaceRoot: context.workspaceRoot,
      signal: context.signal,
    });
  },

  getPermissionIntent: (input) => ({
    riskLevel: 'low',
    accessType: 'read',
    targets: [{ path: input.file_path, accessType: 'read' }],
    promptPolicy: 'whenRequired',
  }),

  async execute(input, context): Promise<PdfReadResult> {
    const filePath = path.resolve(context.workspaceRoot, input.file_path);
    assertReadablePdfPath(filePath);
    context.signal.throwIfAborted();

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Path is not a regular file: ${filePath}`);
    }
    if (fileStat.size > MAX_PDF_BYTES) {
      throw new Error(
        `PDF is too large (${formatMiB(fileStat.size)} MiB > ${formatMiB(MAX_PDF_BYTES)} MiB).`,
      );
    }
    await assertPdfSignature(filePath);

    const startPage = input.start_page ?? 1;
    const requestedPageCount = input.page_count ?? DEFAULT_PAGE_COUNT;
    const requestedEndPage = startPage + requestedPageCount - 1;
    const result = await new PdfReader().readRange(
      { kind: 'path', path: filePath },
      {
        startPage,
        endPage: requestedEndPage,
        signal: context.signal,
      },
    );

    const totalPages = result.pageCount ?? 0;
    const endPage = Math.min(requestedEndPage, totalPages);
    const warnings = (result.failures ?? []).map((failure) => ({
      page: pageFromShardKey(failure.shardKey),
      code: failure.errorCode ?? 'pdf/read-incomplete',
      message: failure.error,
      retryable: failure.retryable,
    }));
    const modelOutput: PdfReadResult = {
      type: 'pdf_content',
      filePath: input.file_path,
      content: formatPdfBlocks(result.blocks, startPage, endPage),
      startPage,
      endPage,
      totalPages,
      ...(endPage < totalPages ? { nextPage: endPage + 1 } : {}),
      warnings,
    };

    return modelOutput;
  },
});

function assertReadablePdfPath(filePath: string): void {
  if (filePath.startsWith('\\\\')) {
    throw new Error(`UNC paths are not supported: ${filePath}`);
  }
  if (isBlockedDevice(filePath)) {
    throw new Error(`Reading from device file is not allowed: ${filePath}`);
  }
  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error(`PdfRead only accepts .pdf files: ${filePath}`);
  }
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

function formatPdfBlocks(blocks: readonly DocumentBlock[], startPage: number, endPage: number): string {
  const pages = new Map<number, DocumentBlock[]>();
  for (const block of blocks) {
    const page = block.page ?? startPage;
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

function formatBlock(block: DocumentBlock): string {
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

function pageFromShardKey(shardKey: string): number {
  const parsed = Number(shardKey.split(':').at(-1));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
