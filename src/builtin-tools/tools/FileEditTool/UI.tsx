// FileEditTool 的桌面展示: 参数(仅路径,old/new 由 diff 表达)与结构化 diff 卡。
// 行号双列与 DiffCard(Review 面板)同一视觉语言;渲染直接消费 hunks,不走文本回环。
import { useState, type JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { FileEditResult } from './FileEditTool.js';
import { patchToUnifiedText, type PatchHunk } from './patch.js';

// ── 类型守卫(消费 unknown data 的唯一入口) ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPatchHunk(value: unknown): value is PatchHunk {
  return isRecord(value)
    && typeof value['oldStart'] === 'number'
    && typeof value['newStart'] === 'number'
    && Array.isArray(value['lines']);
}

/** 失败结果(字符串等)与旧消息都没有这个形状,返回 null 让前端回落通用渲染。 */
export function asFileEditResult(data: unknown): FileEditResult | null {
  if (!isRecord(data)) return null;
  if (
    typeof data['filePath'] === 'string'
    && typeof data['oldString'] === 'string'
    && typeof data['newString'] === 'string'
    && Array.isArray(data['structuredPatch'])
    && data['structuredPatch'].every(isPatchHunk)
    && typeof data['replacements'] === 'number'
  ) {
    return data as unknown as FileEditResult;
  }
  return null;
}

/** 行头摘要：编辑目标路径。 */
export function fileEditTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['file_path'] === 'string' ? args['file_path'] : null;
}

/** 复制文本：权威结构化 diff 的 unified 文本；结果未落地时由前端回落默认复制。 */
export function fileEditCopyText(args: unknown, data: unknown): string | null {
  const result = asFileEditResult(data);
  return result ? patchToUnifiedText(result.structuredPatch) : null;
}

// ── 参数视图: 只给路径; old/new 的正文由结果区 diff 表达,不重复展示 ────────────

export function FileEditArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <span className="break-all font-mono text-[var(--ema-text-secondary)]" title={args['file_path']}>
        {args['file_path']}
      </span>
    </div>
  );
}

// ── 结果视图: diff 卡 ─────────────────────────────────────────────────────────

interface DiffRow {
  key: string;
  kind: 'context' | 'del' | 'add';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

type DiffEntry = DiffRow | { key: string; kind: 'gap' };

/** hunks → 展示行; hunk 之间插 gap 带。行号: 删除行用旧号, 新增行用新号, 上下文双号。 */
function flattenPatch(hunks: readonly PatchHunk[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) entries.push({ key: `gap-${hunkIndex}`, kind: 'gap' });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    hunk.lines.forEach((line, lineIndex) => {
      const marker = line.charAt(0);
      const text = line.slice(1);
      const key = `${hunkIndex}-${lineIndex}`;
      if (marker === '-') {
        entries.push({ key, kind: 'del', oldLine: oldLine++, newLine: null, text });
      } else if (marker === '+') {
        entries.push({ key, kind: 'add', oldLine: null, newLine: newLine++, text });
      } else {
        entries.push({ key, kind: 'context', oldLine: oldLine++, newLine: newLine++, text });
      }
    });
  });
  return entries;
}

/** 复制用: 还原为 unified diff 近似文本(无文件头)。 */
// 序列化器在 patch.ts(形状拥有方), 这里只消费。

export function FileEditResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asFileEditResult(data);
  if (!result) return null;
  // 守卫在纯函数里完成;真正的卡片是组件,内部可以用 hooks。
  return <FileEditDiffCard result={result} />;
}

/** 结构化补丁卡: 红删绿增灰上下文, 行号双列, hunk 间隔带。Edit/Write 共用(第三个消费者出现时再议提取位置)。 */
export function StructuredPatchCard({ hunks }: { hunks: readonly PatchHunk[] }): JSX.Element {
  const entries = flattenPatch(hunks);
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-[var(--ema-border)] font-mono text-[11px] leading-relaxed">
      {entries.map((entry) => {
        if (entry.kind === 'gap') {
          return (
            <div
              key={entry.key}
              className="px-2.5 py-0.5 text-center text-[10px] text-[var(--ema-text-tertiary)] bg-[var(--ema-surface-2)]"
            >
              ···
            </div>
          );
        }
        const tone = entry.kind === 'add'
          ? 'text-[var(--ema-success-text)] bg-[var(--ema-success-muted)]'
          : entry.kind === 'del'
            ? 'text-[var(--ema-danger-text)] bg-[var(--ema-danger-muted)]'
            : 'text-[var(--ema-text-tertiary)]';
        return (
          <div key={entry.key} className={`flex px-2 ${tone}`}>
            <span className="w-9 shrink-0 select-none text-right opacity-60">
              {entry.oldLine ?? ''}
            </span>
            <span className="w-9 shrink-0 select-none text-right opacity-60">
              {entry.newLine ?? ''}
            </span>
            <span className="min-w-0 flex-1 pl-2 whitespace-pre-wrap break-all">
              {entry.kind === 'add' ? '+' : entry.kind === 'del' ? '-' : ' '}
              {entry.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FileEditDiffCard({ result }: { result: FileEditResult }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const additions = result.structuredPatch.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.startsWith('+')).length, 0,
  );
  const deletions = result.structuredPatch.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.startsWith('-')).length, 0,
  );

  return (
    <div className="flex flex-col gap-1 pr-6">
      {/* 头部: 语义行 + 增删计数 + 复制 */}
      <div className="flex items-center gap-2 text-[11px] leading-relaxed">
        <span className="text-[var(--ema-text-secondary)]">
          已编辑 · {result.replacements} 处替换
        </span>
        <span className="text-[var(--ema-success-text)]">+{additions}</span>
        <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
        {result.replaceAll && <Badge variant="primary">replace_all</Badge>}
        <button
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] transition-colors text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]"
          onClick={() => {
            void navigator.clipboard.writeText(patchToUnifiedText(result.structuredPatch)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied
            ? <span className="i-lucide:check text-xs" aria-hidden />
            : <span className="i-lucide:copy text-xs" aria-hidden />}
        </button>
      </div>

      <StructuredPatchCard hunks={result.structuredPatch} />
    </div>
  );
}
