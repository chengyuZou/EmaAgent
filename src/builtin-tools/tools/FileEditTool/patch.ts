// FileEditTool 的结构化补丁生成: hunk 形状与 Claude 的 hunkSchema 对齐,UI 直接消费。
import { structuredPatch } from 'diff';

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 每行以 ' '(上下文)/'-'(删除)/'+'(新增) 开头。 */
  lines: string[];
}

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
): PatchHunk[] {
  return structuredPatch(filePath, filePath, oldContent, newContent, '', '').hunks;
}

/**
 * 在 Tool 生成 structuredPatch 后立即统计一次增删行数. ToolResult 会保存这个结果,
 * Desktop 不需要在每次 React render 时重新扫描同一份 patch.
 */
export function countPatchLines(hunks: readonly PatchHunk[]): PatchLineCounts {
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

/** hunks → unified diff 近似文本(无文件头),供复制与 Review 面板的文本解析器消费。 */
export function patchToUnifiedText(hunks: readonly PatchHunk[]): string {
  return hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n');
}

/** 新建文件内容 → 全新增行的 unified 文本(Review 面板 created 形态的展示输入)。 */
export function additionsToUnifiedText(content: string): string {
  const lines = content.split('\n');
  // split 口径的末尾空行不是真实行("a\n" → ['a',''])。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
}
