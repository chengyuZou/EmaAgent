// Review 的按文件 diff 卡:头部路径/状态/增删/打开标签/折叠,正文统一或分列,上下文段增量展开。
import { useMemo, useState, type JSX } from 'react';
import { Button, IconButton } from '@ema-agent/ui';
import {
  buildSegments,
  parseUnifiedDiff,
  toSplitRows,
  type DiffLine,
  type DiffSegment,
  type SplitRow,
} from './diffModel.js';

/** 折叠段每次只展开的行数(计划 §14:每次展开一小部分,不做智能上下文)。 */
const EXPAND_STEP = 20;

export interface ReviewFileItem {
  readonly key: string;
  readonly displayPath: string;
  /** 打开文件标签用;为 null 时头部不渲染打开动作。 */
  readonly absolutePath: string | null;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly additions: number;
  readonly deletions: number;
  readonly unifiedDiff: string;
  readonly truncated: boolean;
}

const STATUS_META: Record<ReviewFileItem['status'], { icon: string; label: string }> = {
  added:    { icon: 'i-lucide:file-plus-2',  label: '新增' },
  modified: { icon: 'i-lucide:file-diff',    label: '修改' },
  deleted:  { icon: 'i-lucide:file-minus-2', label: '删除' },
  renamed:  { icon: 'i-lucide:file-input',   label: '重命名' },
};

export interface DiffCardProps {
  readonly item: ReviewFileItem;
  readonly expanded: boolean;
  readonly split: boolean;
  readonly wrap: boolean;
  readonly onToggle: () => void;
  readonly onOpenFile?: (absolutePath: string) => void;
}

export function DiffCard({
  item, expanded, split, wrap, onToggle, onOpenFile,
}: DiffCardProps): JSX.Element {
  const meta = STATUS_META[item.status];
  const segments = useMemo(
    () => buildSegments(parseUnifiedDiff(item.unifiedDiff)),
    [item.unifiedDiff],
  );
  // 折叠段已展开行数;key 为段 id,视图切换不丢状态。
  const [revealed, setRevealed] = useState<Readonly<Record<string, number>>>({});

  return (
    <div
      data-review-key={item.key}
      className="overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)]"
    >
      <Button
        variant="ghost"
        className="flex w-full items-center gap-2 rounded-none px-2.5 py-2 text-left"
        onClick={onToggle}
      >
        <span
          className={`${meta.icon} shrink-0 text-sm text-[var(--ema-text-tertiary)]`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]" title={item.displayPath}>
          {item.displayPath}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--ema-text-tertiary)]">{meta.label}</span>
        <span className="shrink-0 text-[11px] text-[var(--ema-success-text)]">+{item.additions}</span>
        <span className="shrink-0 text-[11px] text-[var(--ema-danger-text)]">-{item.deletions}</span>
        <span
          className="i-lucide:chevron-down shrink-0 text-xs text-[var(--ema-text-tertiary)] transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </Button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
      >
        <div>
          <div className="flex items-center gap-1 border-t border-[var(--ema-border)] px-2.5 py-1">
            {item.absolutePath && onOpenFile && (
              <IconButton
                size="sm"
                label={`在标签页中打开 ${item.displayPath}`}
                icon="i-lucide:square-arrow-out-up-right"
                onClick={() => onOpenFile(item.absolutePath!)}
              />
            )}
            {item.truncated && (
              <span className="text-[11px] text-[var(--ema-warning-text)]">diff 过长,已截断</span>
            )}
          </div>
          <div
            className={`max-h-[32rem] overflow-auto border-t border-[var(--ema-border)] font-mono text-[11px] leading-relaxed ${
              wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
            }`}
          >
            {segments.length === 0 ? (
              <p className="px-2.5 py-2 text-[var(--ema-text-tertiary)]">无文本 diff(二进制或空变更)</p>
            ) : (
              segments.map((segment, index) => (
                <DiffSegmentView
                  key={segment.kind === 'lines' ? `lines-${index}` : segment.id}
                  segment={segment}
                  split={split}
                  revealed={segment.kind === 'collapsible' ? revealed[segment.id] ?? 0 : 0}
                  onReveal={(id, count) => setRevealed((current) => ({ ...current, [id]: count }))}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffSegmentView({
  segment, split, revealed, onReveal,
}: {
  segment: DiffSegment;
  split: boolean;
  revealed: number;
  onReveal: (id: string, count: number) => void;
}): JSX.Element {
  if (segment.kind === 'gap') {
    return (
      <div className="px-2.5 py-1 text-center text-[10px] text-[var(--ema-text-tertiary)] bg-[var(--ema-surface-2)]">
        {segment.lineCount} 行未变更
      </div>
    );
  }

  if (segment.kind === 'collapsible') {
    const shown = segment.lines.slice(0, revealed);
    const remaining = segment.lines.length - revealed;
    return (
      <>
        <DiffLines lines={shown} split={split} />
        {remaining > 0 && (
          <button
            className="w-full px-2.5 py-1 text-center text-[10px] transition-colors text-[var(--ema-info-text)] bg-[var(--ema-surface-2)] hover:bg-[var(--ema-info-muted)]"
            onClick={() => onReveal(segment.id, revealed + Math.min(EXPAND_STEP, remaining))}
          >
            展开 {Math.min(EXPAND_STEP, remaining)} 行 · 剩余 {remaining}
          </button>
        )}
      </>
    );
  }

  return <DiffLines lines={segment.lines} split={split} />;
}

function DiffLines({ lines, split }: { lines: readonly DiffLine[]; split: boolean }): JSX.Element {
  if (split) {
    return (
      <>
        {toSplitRows(lines).map((row, index) => (
          <SplitRowView key={index} row={row} />
        ))}
      </>
    );
  }
  return (
    <>
      {lines.map((line, index) => (
        <UnifiedLineView key={index} line={line} />
      ))}
    </>
  );
}

function UnifiedLineView({ line }: { line: DiffLine }): JSX.Element {
  const tone = line.kind === 'add'
    ? 'text-[var(--ema-success-text)] bg-[var(--ema-success-muted)]'
    : line.kind === 'del'
      ? 'text-[var(--ema-danger-text)] bg-[var(--ema-danger-muted)]'
      : 'text-[var(--ema-text-tertiary)]';
  return (
    <div className={`flex px-2.5 ${tone}`}>
      <span className="w-9 shrink-0 select-none text-right opacity-60">{line.oldLine ?? ''}</span>
      <span className="w-9 shrink-0 select-none text-right opacity-60">{line.newLine ?? ''}</span>
      <span className="min-w-0 flex-1 pl-2">
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}{line.text}
      </span>
    </div>
  );
}

function SplitRowView({ row }: { row: SplitRow }): JSX.Element {
  return (
    <div className="grid grid-cols-2 px-2.5">
      <SplitCell side={row.left} />
      <SplitCell side={row.right} />
    </div>
  );
}

function SplitCell({ side }: { side: SplitRow['left'] }): JSX.Element {
  const tone = side.kind === 'del'
    ? 'text-[var(--ema-danger-text)] bg-[var(--ema-danger-muted)]'
    : side.kind === 'add'
      ? 'text-[var(--ema-success-text)] bg-[var(--ema-success-muted)]'
      : side.kind === 'empty'
        ? 'text-[var(--ema-text-tertiary)] bg-[var(--ema-surface-2)]'
        : 'text-[var(--ema-text-tertiary)]';
  return (
    <div className={`flex min-w-0 ${tone}`}>
      <span className="w-9 shrink-0 select-none text-right opacity-60">{side.line ?? ''}</span>
      <span className="min-w-0 flex-1 pl-2">{side.text}</span>
    </div>
  );
}
