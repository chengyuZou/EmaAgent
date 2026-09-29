// 同一个 Session 的文件标签共用浏览器和目录模型, 每个文件预览按资源 ID 保留.
import { memo, useCallback, useMemo, useState, type JSX } from 'react';
import { IconButton, Select, Tooltip } from '@ema-agent/ui';
import { useSessionStore } from '../../../../stores/session.js';
import { useSessionPanelStore } from '../../../../stores/sessionPanel.js';
import { FilePreview } from './FilePreview.js';
import { WorkspaceFileTree } from './workspaceFileTree.js';

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export const FilesPanel = memo(function FilesPanel({ sessionId }: {
  sessionId: string;
}): JSX.Element {
  const loading = useSessionStore(state => state.loading);
  const session = useSessionStore(state => state.sessions.byId.get(sessionId));
  const project = useSessionStore(state => {
    if (!session?.projectId) return undefined;
    return [...state.sessions.pinnedProjects, ...state.sessions.projects]
      .find(item => item.id === session.projectId);
  });
  const roots = useMemo(() => {
    if (project && project.folders.length > 0) return project.folders.map(folder => folder.path);
    return session ? [session.cwd] : [];
  }, [project, session?.cwd]);
  const primaryRoot = project?.folders.find(folder => folder.isPrimary)?.path ?? roots[0];

  if (session?.projectId && !project) {
    return (
      <div className="ema-files-empty">
        {loading ? '正在读取项目…' : '项目不可用'}
      </div>
    );
  }
  if (!primaryRoot) {
    return <div className="ema-files-empty">尚未打开会话</div>;
  }

  return (
    <WorkspaceFiles
      key={JSON.stringify([sessionId, roots])}
      sessionId={sessionId}
      projectName={project?.name ?? null}
      roots={roots}
      primaryRoot={primaryRoot}
    />
  );
});

function WorkspaceFiles({ sessionId, projectName, roots, primaryRoot }: {
  sessionId: string;
  projectName: string | null;
  roots: readonly string[];
  primaryRoot: string;
}): JSX.Element {
  const layout = useSessionPanelStore(state => state.layouts[sessionId]);
  const openWorkspaceFile = useSessionPanelStore(state => state.openWorkspaceFile);
  const [root, setRoot] = useState(primaryRoot);
  const [treeOpen, setTreeOpen] = useState(true);
  const toggleTree = useCallback(() => setTreeOpen(value => !value), []);
  const openFile = useCallback((path: string) => {
    openWorkspaceFile(sessionId, path);
  }, [openWorkspaceFile, sessionId]);
  const fileTabs = useMemo(() => (
    (layout?.tabOrder ?? []).flatMap(id => {
      const tab = layout?.tabsById[id];
      return tab?.kind === 'file' ? [tab] : [];
    })
  ), [layout?.tabOrder, layout?.tabsById]);
  const active = layout?.activeTabId ? layout.tabsById[layout.activeTabId] : undefined;
  const selectedPath = active?.kind === 'file' ? active.path : null;
  const rootOptions = useMemo(() => roots.map(path => ({
    value: path,
    label: roots.some(other => other !== path && folderName(other) === folderName(path))
      ? path
      : folderName(path),
  })), [roots]);

  return (
    <div className="ema-files-panel">
      <div className="ema-files-header">
        <span className="ema-files-location" title={selectedPath ?? root}>
          {selectedPath ?? root}
        </span>
        <Tooltip content={treeOpen ? '隐藏文件树' : '显示文件树'} side="bottom">
          <IconButton
            size="sm"
            variant="ghost"
            label={treeOpen ? '隐藏工作区文件树' : '显示工作区文件树'}
            icon="i-review:reviewFiles"
            toggled={treeOpen}
            aria-pressed={treeOpen}
            onClick={toggleTree}
          />
        </Tooltip>
      </div>
      <div className="ema-files-body">
        <div className="ema-files-content">
          {fileTabs.map(tab => (
            <div key={tab.id} className={tab.id === active?.id ? 'ema-files-preview' : 'hidden'}>
              <FilePreview path={tab.path} />
            </div>
          ))}
          {!selectedPath && (
            <div className="ema-files-empty">
              <span className="i-review:reviewFiles text-3xl" aria-hidden />
              <p>打开文件</p>
              <p className="text-xs text-[var(--ema-text-tertiary)]">从工作区目录树中选择文件</p>
            </div>
          )}
        </div>
        <aside
          className="ema-files-tree-pane"
          data-open={treeOpen}
          aria-label="工作区目录"
          aria-hidden={!treeOpen}
          {...(treeOpen ? {} : { inert: '' })}
        >
          <div className="ema-files-root">
            {roots.length > 1 ? (
              <Select
                value={root}
                options={rootOptions}
                onChange={setRoot}
                aria-label="选择项目源文件夹"
                trigger={folderName(root)}
                className="h-7 w-full text-xs"
              />
            ) : (
              <span title={root} className="truncate">{projectName ?? folderName(root)}</span>
            )}
          </div>
          <WorkspaceFileTree key={root} root={root} selectedPath={selectedPath} onOpen={openFile} />
        </aside>
      </div>
    </div>
  );
}
