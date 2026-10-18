import { useState, type JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { SessionListItem } from '../../api/sessions.js';
import { projectsApi } from '../../api/workspaces.js';
import { showToast } from '../../lib/notifications/toast.js';
import { useSessionStore } from '../../stores/session.js';

export function SessionProjectMenu({ session }: { session: SessionListItem | undefined }): JSX.Element {
  const pinnedProjects = useSessionStore(state => state.sessions.pinnedProjects);
  const projects = useSessionStore(state => state.sessions.projects);
  const [saving, setSaving] = useState(false);
  const availableProjects = [...pinnedProjects, ...projects];
  const currentProject = availableProjects.find(project => project.id === session?.projectId);

  async function changeProject(projectId: string | null): Promise<void> {
    if (!session || saving || projectId === session.projectId) return;
    setSaving(true);
    try {
      // 项目只改变侧栏归属, 已有 Session 的 cwd 保留, 避免改变后续命令的执行目录.
      if (projectId) {
        // 切换项目会直接替换 Session 的项目归属, 不会同时留在旧项目里
        await projectsApi.addSession(projectId, { sessionId: session.id });
      } else if (session.projectId) {
        await projectsApi.removeSession(session.projectId, session.id);
      }
      await useSessionStore.getState().loadSessions();
      const refreshError = useSessionStore.getState().error;
      if (refreshError) {
        showToast(`项目归属已保存, 但列表刷新失败: ${refreshError}`, { variant: 'warning' });
      }
    } catch (error) {
      showToast(
        error instanceof Error ? `切换项目失败: ${error.message}` : '切换项目失败',
        { variant: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  }

  const items = (): MenuItem[] => [
    {
      kind: 'item',
      id: 'project:none',
      label: '不在项目中工作',
      icon: session?.projectId === null ? 'i-lucide:check' : 'i-lucide:x',
      onSelect: () => void changeProject(null),
    },
    ...(availableProjects.length > 0 ? [{ kind: 'separator' } as const] : []),
    ...availableProjects.map((project): MenuItem => ({
      kind: 'item',
      id: `project:${project.id}`,
      label: project.name,
      icon: project.id === session?.projectId ? 'i-lucide:check' : 'i-lucide:folder',
      onSelect: () => void changeProject(project.id),
    })),
  ];

  return (
    <DropdownMenu
      items={items}
      side="bottom"
      align="start"
      widthClass="min-w-56"
      triggerTooltip="切换项目, 执行目录保持不变"
      trigger={(
        <Button
          variant="ghost"
          size="sm"
          disabled={!session || saving}
          aria-label="切换会话项目"
          className="max-w-40 min-w-0 gap-1.5 px-1.5"
        >
          <span className="i-lucide:folder shrink-0 text-sm" aria-hidden />
          <span className="truncate">{currentProject?.name ?? '不在项目中'}</span>
          <span className="i-lucide:chevron-down shrink-0 text-xs" aria-hidden />
        </Button>
      )}
    />
  );
}
