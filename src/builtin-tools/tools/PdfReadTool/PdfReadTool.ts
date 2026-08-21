// 按有限页范围读取 PDF 文本层，并明确报告扫描页和图表未解析等不完整结果。
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ImageReader, PdfReader, type CallVision, type DocumentBlock } from '@ema-agent/knowledge';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { checkReadPathPermission } from '../shared/pathPermission.js';
import { isBlockedDevice } from '../FileReadTool/FileReadTool.js';
import {
  DEFAULT_PAGE_COUNT,
  MAX_PAGE_COUNT,
  MAX_PDF_BYTES,
  MAX_RESULT_BYTES,
} from './limits.js';
import { PDF_READ_DESCRIPTION } from './prompt.js';

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
}).strict();

type PdfReadInput = z.infer<typeof inputSchema>;

/** PdfReadTool 的窄 Context：工作区根 + 可选视觉模型; 取消与身份走 ToolInvocation。 */
interface PdfReadToolContext {
  workspaceRoot: string;
  vision?: CallVision;
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

export const PdfReadTool = buildTool<PdfReadInput, PdfReadResult, PdfReadToolContext>({
  id: BuiltinTools.PdfRead.id,
  name: BuiltinTools.PdfRead.name,
  description: PDF_READ_DESCRIPTION,
  maxResultBytes: MAX_RESULT_BYTES,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  getToolUseSummary: (input) => input.file_path,

  validateContext(context) {
    if (!context.workspaceRoot) {
      return contextFail('PDF 读取工具未装配工作区。');
    }
    // vision 可选: 缺省时 PDF 只读文本层(扫描页/图表占位 + warning), 不阻断。
    return contextOk({ workspaceRoot: context.workspaceRoot, vision: context.vision });
  },

  // 路径形状在 Permission 之前校验; 文件存在/签名/体积留在 execute 用 fs 复查。
  validateInput(input) {
    const issue = assertReadablePdfPath(input.file_path);
    return issue
      ? { valid: false, code: 'pdf/invalid_path', message: issue }
      : { valid: true };
  },

  checkPermissions: async (input, context, permissionContext) =>
    checkReadPathPermission({
      toolName: BuiltinTools.PdfRead.name,
      path: path.resolve(context.workspaceRoot, input.file_path),
      workspaceRoot: context.workspaceRoot,
      permissionContext,
    }),

  async execute(
    input: PdfReadInput,
    context: PdfReadToolContext,
    invocation: ToolInvocation,
  ): Promise<PdfReadResult> {
    const filePath = path.resolve(context.workspaceRoot, input.file_path);
    invocation.signal.throwIfAborted();

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
    // 配了 vision 绑定 → 扫描页 OCR / 图注描述; 缺省降级纯文本(占位 + warning)。
    const imageReader = context.vision
      ? new ImageReader(context.vision, {
          signal: invocation.signal,
        })
      : undefined;
    const result = await new PdfReader(imageReader).readRange(
      { kind: 'path', path: filePath },
      {
        startPage,
        endPage: requestedEndPage,
        signal: invocation.signal,
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

    return {
      type: 'pdf_content',
      filePath: input.file_path,
      content: formatPdfBlocks(result.blocks, startPage, endPage),
      startPage,
      endPage,
      totalPages,
      ...(endPage < totalPages ? { nextPage: endPage + 1 } : {}),
      warnings,
    };
  },

  // 模型只需要正文; 读取不完整的页单独列一节, 不让模型误以为全文完整。
  mapResultToModelContent(output) {
    if (output.warnings.length === 0) return output.content;
    const lines = output.warnings.map(
      (warning) => `- 第 ${warning.page} 页: ${warning.message}`,
    );
    return `${output.content}\n\n[读取不完整]\n${lines.join('\n')}`;
  },
});

function assertReadablePdfPath(filePath: string): string | null {
  if (filePath.startsWith('\\\\')) {
    return `UNC paths are not supported: ${filePath}`;
  }
  if (isBlockedDevice(filePath)) {
    return `Reading from device file is not allowed: ${filePath}`;
  }
  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    return `PdfRead only accepts .pdf files: ${filePath}`;
  }
  return null;
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
  blocks: readonly DocumentBlock[],
  startPage: number,
  endPage: number,
): string {
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
