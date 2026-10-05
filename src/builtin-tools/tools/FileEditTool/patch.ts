import { formatPatch, OMIT_HEADERS, structuredPatch, type StructuredPatchHunk } from 'diff';

export interface PatchLineCounts {
  /** structuredPatch 中以 `+` 开头的新增行数. */
  readonly additions: number;
  /** structuredPatch 中以 `-` 开头的删除行数. */
  readonly deletions: number;
}

/** 由编辑前后全文生成 hunks; 不生成文件头,上下文行数用 diff 包默认(3 行)。 */
export function buildStructuredPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): StructuredPatchHunk[] {
  return structuredPatch(filePath, filePath, oldContent, newContent, '', '').hunks;
}

/**
 * 在 Tool 生成 structuredPatch 后立即统计一次增删行数. ToolResult 会保存这个结果,
 * Desktop 不需要在每次 React render 时重新扫描同一份 patch.
 */
export function countPatchLines(hunks: readonly StructuredPatchHunk[]): PatchLineCounts {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

/** 新建文件没有 structuredPatch, 所以按实际文本行数记录全部新增行. */
export function countCreatedFileLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

/** 复制正文沿用官方补丁序列化, 不重复实现 hunk 行号或末尾换行规则. */
export function patchToUnifiedText(hunks: readonly StructuredPatchHunk[]): string {
  return formatPatch({
    oldFileName: '',
    newFileName: '',
    oldHeader: '',
    newHeader: '',
    hunks: [...hunks],
  }, OMIT_HEADERS);
}
