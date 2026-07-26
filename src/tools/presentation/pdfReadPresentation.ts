// 描述一次 PDF 页范围读取，前端无需从模型正文猜测页数和续读位置。
export interface PdfReadPresentation {
  readonly kind: 'pdf_read';
  readonly filePath: string;
  readonly startPage: number;
  readonly endPage: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  readonly incompletePages: number;
}

export interface CreatePdfReadPresentationInput {
  readonly filePath: string;
  readonly startPage: number;
  readonly endPage: number;
  readonly totalPages: number;
  readonly incompletePages: number;
}

export function createPdfReadPresentation(
  input: CreatePdfReadPresentationInput,
): PdfReadPresentation {
  return {
    ...input,
    kind: 'pdf_read',
    hasMore: input.endPage < input.totalPages,
  };
}
