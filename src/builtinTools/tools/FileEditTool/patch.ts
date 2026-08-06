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

/** 由编辑前后全文生成 hunks; 不生成文件头,上下文行数用 diff 包默认(3 行)。 */
export function buildStructuredPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): PatchHunk[] {
  return structuredPatch(filePath, filePath, oldContent, newContent, '', '').hunks;
}

/** hunks → unified diff 近似文本(无文件头),供复制与 Review 面板的文本解析器消费。 */
export function patchToUnifiedText(hunks: readonly PatchHunk[]): string {
  return hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n');
}
