// 把 unified diff 解析为结构化 hunk/行,并推导折叠段与分列行;纯函数,供 Review 渲染与测试。

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del';
  /** 不含 +/- 前缀的正文。 */
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface DiffHunk {
  /** @@ 行原文(含可选的函数名后缀)。 */
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export interface ParsedDiff {
  readonly hunks: readonly DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** 解析 unified diff 的正文部分;头部(diff --git/index/---/+++)行被跳过。 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let current: { header: string; oldStart: number; newStart: number; lines: DiffLine[] } | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      current = {
        header: raw,
        oldStart: Number(hunkMatch[1]),
        newStart: Number(hunkMatch[2]),
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
    // "\ No newline at end of file" 与 split 尾 artifact 不产生行。
  }
  return { hunks };
}

// ── 折叠段:变更行恒显,长上下文折叠为可增量展开的段,hunk 间隔为无数据段 ──────

export type DiffSegment =
  | { readonly kind: 'lines'; readonly lines: readonly DiffLine[] }
  /** 上下文缓冲区内的折叠段;revealed 由组件状态推进,每次只展开一小段。 */
  | { readonly kind: 'collapsible'; readonly id: string; readonly lines: readonly DiffLine[] }
  /** hunk 之间的未变更间隔;diff 不携带这些内容,只能如实标行数,不可展开。 */
  | { readonly kind: 'gap'; readonly id: string; readonly lineCount: number };

/** hunk 内上下文超过 keep*2 行时,中段折叠;两端各保留 keep 行邻近上下文。 */
export function buildSegments(parsed: ParsedDiff, keep = 3): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let previousHunkOldEnd: number | null = null;

  parsed.hunks.forEach((hunk, hunkIndex) => {
    if (previousHunkOldEnd !== null) {
      const gap = hunk.oldStart - previousHunkOldEnd;
      if (gap > 0) {
        segments.push({ kind: 'gap', id: `gap-${hunkIndex}`, lineCount: gap });
      }
    }

    let runStart = -1;
    let segmentIndex = 0;
    const flushContextRun = (endExclusive: number): void => {
      if (runStart < 0) return;
      const run = hunk.lines.slice(runStart, endExclusive);
      if (run.length > keep * 2) {
        segments.push({ kind: 'lines', lines: run.slice(0, keep) });
        segments.push({
          kind: 'collapsible',
          id: `h${hunkIndex}-s${segmentIndex++}`,
          lines: run.slice(keep, run.length - keep),
        });
        segments.push({ kind: 'lines', lines: run.slice(run.length - keep) });
      } else {
        segments.push({ kind: 'lines', lines: run });
      }
      runStart = -1;
    };

    hunk.lines.forEach((line, index) => {
      if (line.kind === 'context') {
        if (runStart < 0) runStart = index;
      } else {
        flushContextRun(index);
        segments.push({ kind: 'lines', lines: [line] });
      }
    });
    flushContextRun(hunk.lines.length);

    // 本 hunk 消费的旧侧行数 = context + del;add 行不占旧侧,不能靠末行行号反推。
    const oldConsumed = hunk.lines.filter((line) => line.kind !== 'add').length;
    previousHunkOldEnd = hunk.oldStart + oldConsumed;
  });

  return segments;
}

// ── 分列行:删除与新增按序配对,上下文占两侧,落单侧补空 ─────────────────────

export interface SplitSide {
  readonly line: number | null;
  readonly text: string;
  readonly kind: 'del' | 'add' | 'context' | 'empty';
}

export interface SplitRow {
  readonly left: SplitSide;
  readonly right: SplitSide;
}

export function toSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let delBuffer: DiffLine[] = [];
  let addBuffer: DiffLine[] = [];

  const flush = (): void => {
    const pairCount = Math.max(delBuffer.length, addBuffer.length);
    for (let i = 0; i < pairCount; i += 1) {
      const del = delBuffer[i];
      const add = addBuffer[i];
      rows.push({
        left: del
          ? { line: del.oldLine, text: del.text, kind: 'del' }
          : { line: null, text: '', kind: 'empty' },
        right: add
          ? { line: add.newLine, text: add.text, kind: 'add' }
          : { line: null, text: '', kind: 'empty' },
      });
    }
    delBuffer = [];
    addBuffer = [];
  };

  for (const line of lines) {
    if (line.kind === 'del') delBuffer.push(line);
    else if (line.kind === 'add') addBuffer.push(line);
    else {
      flush();
      rows.push({
        left: { line: line.oldLine, text: line.text, kind: 'context' },
        right: { line: line.newLine, text: line.text, kind: 'context' },
      });
    }
  }
  flush();
  return rows;
}
