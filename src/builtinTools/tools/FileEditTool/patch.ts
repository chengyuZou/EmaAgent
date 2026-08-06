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

/** 新建文件内容 → 全新增行的 unified 文本(Review 面板 created 形态的展示输入)。 */
export function additionsToUnifiedText(content: string): string {
  const lines = content.split('\n');
  // split 口径的末尾空行不是真实行("a\n" → ['a',''])。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
}
