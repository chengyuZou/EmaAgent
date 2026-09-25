// 显示当前 Assistant 气泡从 FileEdit/FileWrite 结果整理出的文件清单和增删行数.
// 这里只负责展示, 不重新读取 Git, 也不提供没有后端实现的撤销按钮.
import { useState, type JSX } from 'react';

import type { EditedFile} from './toolGroups.js';

const PAGE_SIZE = 5;

export function EditedFilesCard({
  files, additions, deletions,
}: {
  files: readonly EditedFile[];
  additions: number;
  deletions: number;
}): JSX.Element {
  const [visible, setVisible] = useState(PAGE_SIZE);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="i-lucide:file-diff shrink-0 text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
        <span className="text-xs font-medium text-[var(--ema-text-primary)]">
          已编辑 {files.length} 个文件
        </span>
        <span className="text-[11px] text-[var(--ema-success-text)]">+{additions}</span>
        <span className="text-[11px] text-[var(--ema-danger-text)]">-{deletions}</span>
      </div>
      <div className="border-t border-[var(--ema-border)]">
        {files.slice(0, visible).map((file) => (
          <div
            key={file.path}
            className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--ema-border)] last:border-b-0"
          >
            <span
              className={`shrink-0 text-xs ${file.created ? 'i-lucide:file-plus-2' : 'i-lucide:file-diff'} text-[var(--ema-text-tertiary)]`}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ema-text-secondary)]" title={file.path}>
              {file.path}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--ema-success-text)]">+{file.additions}</span>
            <span className="shrink-0 text-[11px] text-[var(--ema-danger-text)]">-{file.deletions}</span>
          </div>
        ))}
        {files.length > visible && (
          <button
            className="w-full px-3 py-1.5 text-center text-[11px] transition-colors text-[var(--ema-primary)] hover:bg-[var(--ema-surface-2)]"
            onClick={() => setVisible((count) => count + PAGE_SIZE)}
          >
            再显示 {Math.min(PAGE_SIZE, files.length - visible)} 个文件
          </button>
        )}
      </div>
    </div>
  );
}
