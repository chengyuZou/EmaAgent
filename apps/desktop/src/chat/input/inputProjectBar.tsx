import { useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Input, Tooltip, type MenuItem } from '@ema-agent/ui';
import { projectsApi } from '../../api/workspaces.js';
import type { SessionListItem } from '../../api/sessions.js';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { useSessionStore } from '../../stores/session.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';

export function InputProjectBar({ sessionId: viewedId, session: viewedSession, projectId: currentProjectId }: {
  sessionId: string | null;
  session: SessionListItem | undefined;
  projectId: string | null;
}): JSX.Element {
  const newSessionCwd = useChatNavigationStore(state => state.newSessionCwd);
  const pinnedProjects = useSessionStore(state => state.sessions.pinnedProjects);
  const projects = useSessionStore(state => state.sessions.projects);
  const [changingProject, setChangingProject] = useState(false);
  const availableProjects = [...pinnedProjects, ...projects];
  const currentProject = availableProjects.find(project => project.id === currentProjectId);
  const inheritedNewCwd = currentProject?.folders.find(folder => folder.isPrimary)?.path ?? '';
  const displayedNewCwd = newSessionCwd ?? inheritedNewCwd;

  async function changeProject(projectId: string | null): Promise<void> {
    if (projectId === currentProjectId || changingProject) return;
    if (!viewedId) {
      useChatNavigationStore.getState().openNewSession(projectId ?? undefined);
      return;
    }
    if (!viewedSession) return;

    setChangingProject(true);
    try {
      if (projectId) {
        await projectsApi.addSession(projectId, { sessionId: viewedId });
      } else if (viewedSession.projectId) {
        await projectsApi.removeSession(viewedSession.projectId, viewedId);
      }
      await useSessionStore.getState().loadSessions();
      const refreshError = useSessionStore.getState().error;
      if (refreshError) {
        showToast(
          `项目归属已保存，但列表刷新失败: ${refreshError}`,
          { variant: 'warning' },
        );
      }
    } catch (error) {
      showToast(
        error instanceof Error ? `切换项目失败: ${error.message}` : '切换项目失败',
        { variant: 'danger' },
      );
    } finally {
      setChangingProject(false);
    }
  }

  async function pickNewCwd(): Promise<void> {
    try {
      const path = await tauriBridge.openFileDialog({ directory: true });
      if (path) useChatNavigationStore.getState().setNewSessionCwd(path);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '选择执行目录失败',
        { variant: 'danger' },
      );
    }
  }

  const projectItems = (): MenuItem[] => [
    {
      kind: 'item',
      id: 'project:none',
      label: '不在项目中工作',
      icon: currentProjectId === null ? 'i-lucide:check' : 'i-lucide:x',
      onSelect: () => void changeProject(null),
    },
    ...(availableProjects.length > 0 ? [{ kind: 'separator' } as const] : []),
    ...availableProjects.map((project): MenuItem => ({
      kind: 'item',
      id: `project:${project.id}`,
      label: project.name,
      icon: project.id === currentProjectId ? 'i-lucide:check' : 'i-lucide:folder',
      onSelect: () => void changeProject(project.id),
    })),
  ];

  return (
    <div
      className="ema-fade-in mb-2 flex w-full min-w-0 items-center gap-2 px-1 text-xs text-[var(--ema-text-secondary)]"
    >
      <DropdownMenu
        side="top"
        align="start"
        widthClass="min-w-56"
        items={projectItems}
        trigger={(
          <Button
            variant="ghost"
            size="sm"
            disabled={changingProject || (viewedId !== null && !viewedSession)}
            className="max-w-56 gap-1.5 rounded-md px-2"
            title={currentProject?.name ?? '不在项目中工作'}
          >
            <span className="i-lucide:folder shrink-0 text-sm" aria-hidden />
            <span className="truncate">{currentProject?.name ?? '选择项目'}</span>
            <span className="i-lucide:chevron-down shrink-0 text-xs" aria-hidden />
          </Button>
        )}
      />
      {!viewedId && (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <label htmlFor="new-session-cwd" className="shrink-0">cwd:</label>
          <Tooltip
            variant="card"
            side="top"
            content={<span className="block max-w-lg break-all font-mono">{displayedNewCwd || '使用 Ema 默认工作目录'}</span>}
          >
            <Input
              id="new-session-cwd"
              aria-label="新对话执行目录"
              autoComplete="off"
              spellCheck={false}
              value={displayedNewCwd}
              onChange={event => useChatNavigationStore.getState().setNewSessionCwd(event.target.value)}
              placeholder="使用 Ema 默认工作目录"
              className="min-w-0 flex-1"
            />
          </Tooltip>
          {currentProject && currentProject.folders.length > 0 && (
            <DropdownMenu
              side="top"
              align="end"
              widthClass="min-w-64 max-w-lg"
              items={currentProject.folders.map(folder => ({
                kind: 'item',
                id: `folder:${folder.path}`,
                label: folder.path,
                icon: folder.path === displayedNewCwd ? 'i-lucide:check' : 'i-lucide:folder',
                onSelect: () => useChatNavigationStore.getState().setNewSessionCwd(folder.path),
              }))}
              trigger={(
                <IconButton size="sm" variant="ghost" icon="i-lucide:list" label="从项目文件夹中选择" />
              )}
            />
          )}
          <IconButton
            size="sm"
            variant="ghost"
            icon="i-lucide:folder-open"
            label="选择执行目录"
            onClick={() => void pickNewCwd()}
          />
        </div>
      )}
    </div>
  );
}
