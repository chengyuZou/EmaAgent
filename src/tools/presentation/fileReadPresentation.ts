// 描述一次文件读取在界面中需要展示的路径、行区间和裁剪状态。
export interface FileReadPresentation {
  readonly kind: 'file_read';
  readonly filePath: string;
  readonly status: 'content' | 'unchanged';
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines?: number;
  readonly partial: boolean;
  readonly truncated: boolean;
}

export interface CreateFileReadPresentationInput {
  readonly filePath: string;
  readonly status: 'content' | 'unchanged';
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines?: number;
  readonly partial: boolean;
  readonly truncated: boolean;
}

export function createFileReadPresentation(
  input: CreateFileReadPresentationInput,
): FileReadPresentation {
  return { ...input, kind: 'file_read' };
}
