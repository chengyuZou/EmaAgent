// 显示当前 Assistant 气泡从 FileEdit/FileWrite 结果整理出的文件清单和增删行数.
// 这里只负责展示, 不重新读取 Git, 也不提供没有后端实现的撤销按钮.
import { useId, useState, type JSX } from 'react';
import { useCollapsibleBody } from '../messageExpansion.js';

import type { EditedFile } from './toolGroups.js';

export function EditedFilesCard({
  files, additions, deletions,
}: {
  files: readonly EditedFile[];
  additions: number;
  deletions: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { containerRef, mounted } = useCollapsibleBody(expanded);
  const extraFilesId = useId();
  const preview = files.slice(0, 3);
  const remaining = files.slice(3);

  return (
    <div className="ema-edited-files-card">
      <div className="ema-edited-files-header">
        <span className="ema-edited-files-icon" aria-hidden>
          <span className="i-lucide:file-diff text-lg" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-[var(--ema-text-primary)]">
            已编辑 {files.length} 个文件
          </span>
          <FileLineCounts additions={additions} deletions={deletions} />
        </div>
      </div>
      <div>
        {preview.map(file => <EditedFileRow key={file.path} file={file} />)}
        {remaining.length > 0 && (
          <>
            <div
              ref={containerRef}
              id={extraFilesId}
              className="ema-collapsible ema-edited-files-extra"
              style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
              aria-hidden={!expanded}
            >
              <div className="min-h-0">
                {mounted && remaining.map(file => <EditedFileRow key={file.path} file={file} />)}
              </div>
            </div>
            <button
              type="button"
              className="ema-edited-files-toggle"
              aria-expanded={expanded}
              aria-controls={extraFilesId}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? '收起文件' : `再显示 ${remaining.length} 个文件`}
              <span className="i-lucide:chevron-down" aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function EditedFileRow({ file }: { file: EditedFile }): JSX.Element {
  const displayPath = file.path.replace(/\\/g, '/');
  const separator = displayPath.lastIndexOf('/');
  const directory = displayPath.slice(0, separator + 1);
  const name = displayPath.slice(separator + 1);
  return (
    <div className="ema-edited-file-row">
      <span className="ema-edited-file-path" title={displayPath}>
        {directory && <span className="ema-edited-file-directory">{directory}</span>}
        <span className="ema-edited-file-name">{name}</span>
      </span>
      <FileLineCounts additions={file.additions} deletions={file.deletions} />
    </div>
  );
}

function FileLineCounts({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span className="ema-edited-files-counts">
      <span className="text-[var(--ema-success-text)]">+{additions}</span>
      <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
    </span>
  );
}
