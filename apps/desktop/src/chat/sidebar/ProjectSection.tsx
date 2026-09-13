// 渲染项目分区、项目操作与成员会话。
import { useEffect, useState, type JSX } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  Input,
  type MenuItem,
} from '@ema-agent/ui';
import type { Project, SessionListItem } from '../../api/sessions.js';
import { projectsApi } from '../../api/workspaces.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { runWithToast } from '../../lib/toast.js';
import type { AgentSessionState } from '../../stores/agent.js';
import { useSessionStore } from '../../stores/session.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { SessionRow } from './SessionRow.js';

interface ProjectSectionProps {
  projects: Project[];
  viewedId: string | null;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
}

export function PinnedSection({
  projects,
  sessions,
  viewedId,
  agentSessions,
}: {
  projects: Project[];
  sessions: SessionListItem[];
  viewedId: string | null;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);

  if (projects.length === 0 && sessions.length === 0) return null;

  return (
    <section className="mb-1">
      <SectionButton
        label="置顶"
        collapsed={collapsed}
        onClick={() => setCollapsed((value) => !value)}
      />
      <Collapse open={!collapsed}>
        <div className="flex flex-col gap-0.5 px-1.5 pb-1">
          {projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              viewedId={viewedId}
              agentSessions={agentSessions}
            />
          ))}
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === viewedId}
              agentSessions={agentSessions}
            />
          ))}
        </div>
      </Collapse>
    </section>
  );
}

export function ProjectSection({
  projects,
  viewedId,
  agentSessions,
}: ProjectSectionProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);

  return (
    <section className="mb-1">
      <SectionButton
        label="项目"
        collapsed={collapsed}
        onClick={() => setCollapsed((value) => !value)}
        onAdd={() => setCreating(true)}
      />

      <Collapse open={!collapsed}>
        <div className="flex flex-col gap-1 px-1.5 pb-1">
          {projects.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[var(--ema-text-tertiary)]">
              暂无项目
            </p>
          ) : (
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                viewedId={viewedId}
                agentSessions={agentSessions}
              />
            ))
          )}
        </div>
      </Collapse>
      <ProjectCreator open={creating} onClose={() => setCreating(false)} />
    </section>
  );
}

function ProjectCreator({ open, onClose }: {
  open: boolean;
  onClose(): void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [primaryFolderPath, setPrimaryFolderPath] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setFolderPaths([]);
      setPrimaryFolderPath('');
    }
  }, [open]);

  async function pickFolder(): Promise<void> {
    const selectedPaths = await runWithToast(
      tauriBridge.openFileDialogMultiple({ directory: true }),
      '选择源文件夹失败',
    );
    if (!selectedPaths || selectedPaths.length === 0) return;
    const addedPaths = selectedPaths.filter((path) => !folderPaths.includes(path));
    if (addedPaths.length > 0) {
      setFolderPaths([...folderPaths, ...addedPaths]);
      if (folderPaths.length === 0) setPrimaryFolderPath(addedPaths[0]!);
    }
  }

  function removeFolder(path: string): void {
    const remaining = folderPaths.filter((folder) => folder !== path);
    setFolderPaths(remaining);
    if (primaryFolderPath === path) {
      setPrimaryFolderPath(remaining[0] ?? '');
    }
  }

  async function create(): Promise<void> {
    setSaving(true);
    try {
      const project = await runWithToast(
        projectsApi.create({
          name: name.trim(),
          folderPaths,
          primaryFolderPath,
        }),
        '创建项目失败',
      );
      if (!project) return;
      await useSessionStore.getState().loadSessions();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="创建项目"
      widthClass="max-w-lg"
    >
      <div className="relative">
        <span
          className="i-lucide:folder absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--ema-text-tertiary)]"
          aria-hidden
        />
        <Input
          aria-label="项目名称"
          className="h-10 rounded-lg pl-10 font-sans"
          placeholder="项目名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </div>
      <p className="mb-2 mt-4 text-sm text-[var(--ema-text-secondary)]">
        源文件夹
      </p>
      <div className="overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-3)]">
        {folderPaths.map((path) => (
          <div
            key={path}
            className="flex min-h-12 items-center gap-3 border-b border-[var(--ema-border)] px-3 text-sm text-[var(--ema-text-primary)]"
          >
            <span className="i-lucide:folder shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={path}>
              {path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path}
            </span>
            {primaryFolderPath === path ? (
              <span className="shrink-0 rounded-md border border-[var(--ema-border)] px-2 py-1 text-xs text-[var(--ema-text-secondary)]">
                主要
              </span>
            ) : (
              <button
                type="button"
                className="shrink-0 rounded-md border border-[var(--ema-border)] px-2 py-1 text-xs text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
                onClick={() => setPrimaryFolderPath(path)}
              >
                设为主要
              </button>
            )}
            <button
              type="button"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
              aria-label={`移除源文件夹 ${path}`}
              onClick={() => removeFolder(path)}
            >
              <span className="i-lucide:x text-sm" aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`flex w-full cursor-pointer items-center gap-3 px-3 text-left text-sm text-[var(--ema-text-primary)] transition-colors hover:bg-[var(--ema-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ema-primary)] ${
            folderPaths.length === 0 ? 'min-h-24 flex-col justify-center gap-2' : 'min-h-12'
          }`}
          onClick={() => void pickFolder()}
        >
          <span className="i-lucide:folder-plus shrink-0 text-base text-[var(--ema-text-secondary)]" aria-hidden />
          <span>
            {folderPaths.length === 0
              ? '添加可读取和编辑的文件夹'
              : '添加文件夹'}
          </span>
        </button>
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <button
          type="button"
          className="h-9 rounded-lg bg-[var(--ema-text-primary)] px-4 text-sm font-medium text-[var(--ema-bg)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!name.trim() || folderPaths.length === 0 || saving}
          onClick={() => void create()}
        >
          {saving ? '创建中…' : '创建项目'}
        </button>
      </div>
    </Dialog>
  );
}

function ProjectRow({
  project,
  viewedId,
  agentSessions,
}: {
  project: Project;
  viewedId: string | null;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
}): JSX.Element {
  const active = project.sessions.some((session) => session.id === viewedId);
  const [collapsed, setCollapsed] = useState(!active);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (active) setCollapsed(false);
  }, [active]);

  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: project.pinned ? '取消置顶' : '置顶',
      icon: project.pinned ? 'i-lucide:pin-off' : 'i-lucide:pin',
      onSelect: () => void runWithToast(
        projectsApi.pin(project.id, !project.pinned)
          .then(() => useSessionStore.getState().loadSessions()),
        '项目置顶失败',
      ),
    },
    {
      kind: 'item',
      label: '编辑',
      icon: 'i-lucide:settings-2',
      onSelect: () => setEditing(true),
    },
    { kind: 'separator' },
    ...(project.folders.length > 0 ? [{
      kind: 'submenu' as const,
      label: '在资源管理器中打开',
      icon: 'i-lucide:folder-open',
      items: project.folders.map((folder) => ({
        kind: 'item' as const,
        label: `${folder.path}${folder.isPrimary ? ' · 主文件夹' : ''}`,
        onSelect: () => void runWithToast(
          tauriBridge.openPath(folder.path),
          '打开文件夹失败',
        ),
      })),
    }] : []),
    { kind: 'separator' },
    {
      kind: 'item',
      label: '移除项目',
      icon: 'i-lucide:folder-x',
      danger: true,
      onSelect: () => setRemoving(true),
    },
  ];

  return (
    <div>
      <div
        className={`group flex h-9 w-full items-center gap-1 rounded-md border border-transparent px-1 text-sm font-normal focus-within:border-[var(--ema-primary)] ${
          active
            ? 'bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]'
            : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
        }`}
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left focus:outline-none"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <span
            className="i-lucide:folder text-base text-[var(--ema-text-tertiary)]"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {project.name}
          </span>
          <span
            className={`i-lucide:chevron-down text-xs transition-transform ${
              collapsed ? '-rotate-90' : ''
            } opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`}
            aria-hidden
          />
        </button>
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-0 text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-3)] hover:text-[var(--ema-primary)] focus:outline-none"
          aria-label={`在 ${project.name} 中新建对话`}
          onClick={() => useChatWorkspace.getState().openNewSession(project.id)}
        >
          <span className="i-lucide:plus-circle text-sm" aria-hidden />
        </button>
        <DropdownMenu
          trigger={
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-0 text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-3)] focus:outline-none"
              aria-label={`${project.name} 项目菜单`}
            >
              <span className="i-solar:menu-dots-bold-duotone text-xs" aria-hidden />
            </button>
          }
          items={menuItems}
          side="right"
          align="start"
          widthClass="min-w-56"
        />
      </div>

      <Collapse open={!collapsed}>
        <div className="flex flex-col gap-0.5 pt-0.5">
          {project.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === viewedId}
              agentSessions={agentSessions}
              nested
            />
          ))}
        </div>
      </Collapse>
      <ProjectEditor
        project={project}
        open={editing}
        onClose={() => setEditing(false)}
      />
      <ConfirmDialog
        open={removing}
        title="移除项目"
        message={`移除「${project.name}」？成员对话会保留，原工作区路径也不会删除。`}
        confirmText="移除项目"
        onConfirm={() => {
          setRemoving(false);
          void runWithToast(
            projectsApi.remove(project.id)
              .then(async () => {
                if (useChatWorkspace.getState().newSessionProjectId === project.id) {
                  useChatWorkspace.getState().openNewSession();
                }
                await useSessionStore.getState().loadSessions();
              }),
            '移除项目失败',
          );
        }}
        onCancel={() => setRemoving(false)}
      />
    </div>
  );
}

function ProjectEditor({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose(): void;
}): JSX.Element {
  const [name, setName] = useState(project.name);
  useEffect(() => {
    setName(project.name);
  }, [project.name, open]);

  async function change(
    action: Promise<unknown>,
    errorMessage: string,
  ): Promise<void> {
    await runWithToast(
      action.then(() => useSessionStore.getState().loadSessions()),
      errorMessage,
    );
  }

  async function addFolder(): Promise<void> {
    const selectedPaths = await runWithToast(
      tauriBridge.openFileDialogMultiple({ directory: true }),
      '选择源文件夹失败',
    );
    if (selectedPaths && selectedPaths.length > 0) {
      const existingPaths = new Set(project.folders.map((folder) => folder.path));
      const addedPaths = selectedPaths.filter((path) => !existingPaths.has(path));
      if (addedPaths.length === 0) return;
      await change(
        Promise.all(addedPaths.map((path) => projectsApi.addFolder(project.id, path))),
        '添加源文件夹失败',
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="编辑项目"
      widthClass="max-w-lg"
    >
      <label
        className="mb-2 block text-sm text-[var(--ema-text-secondary)]"
        htmlFor={`project-name-${project.id}`}
      >
        项目名称
      </label>
      <div className="flex gap-2">
        <Input
          id={`project-name-${project.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          variant="primary"
          disabled={!name.trim() || name.trim() === project.name}
          onClick={() => void change(
            projectsApi.patch(project.id, name.trim()),
            '项目重命名失败',
          )}
        >
          保存
        </Button>
      </div>
      <div className="mt-5 flex items-center justify-between">
        <span className="text-sm text-[var(--ema-text-secondary)]">源文件夹</span>
        <Button variant="ghost" size="sm" onClick={() => void addFolder()}>
          <span className="i-lucide:plus mr-1" aria-hidden />
          添加文件夹
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {project.folders.map((folder) => (
          <div
            key={folder.path}
            className="flex items-center gap-2 rounded-md border border-[var(--ema-border)] p-2 text-sm"
          >
            <span className="min-w-0 flex-1 break-all text-[var(--ema-text-primary)]">
              {folder.path}
            </span>
            {folder.isPrimary ? (
              <span className="shrink-0 rounded-md border border-[var(--ema-border)] px-2 py-1 text-xs text-[var(--ema-primary)]">
                主要
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="border border-[var(--ema-border)]"
                onClick={() => void change(
                  projectsApi.setPrimaryFolder(project.id, folder.path),
                  '设置主文件夹失败',
                )}
              >
                设为主要
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={project.folders.length <= 1}
              title={project.folders.length <= 1 ? '项目至少保留一个源文件夹' : '移除文件夹'}
              onClick={() => void change(
                projectsApi.removeFolder(project.id, folder.path),
                '移除源文件夹失败',
              )}
            >
              <span className="i-lucide:x" aria-hidden />
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      className="ema-collapsible"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
      }}
    >
      <div>{children}</div>
    </div>
  );
}

interface SectionButtonProps {
  label: string;
  collapsed: boolean;
  onClick(): void;
  onAdd?(): void;
}

export function SectionButton({
  label,
  collapsed,
  onClick,
  onAdd,
}: SectionButtonProps): JSX.Element {
  return (
    <div className="group mx-1.5 mb-0.5 flex h-9 items-center rounded-md border border-transparent text-[var(--ema-text-tertiary)] transition-colors hover:border-[var(--ema-border)] hover:bg-[var(--ema-surface-2)] focus-within:border-[var(--ema-primary)] focus-within:bg-[var(--ema-surface-2)]">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-xs focus:outline-none"
        onClick={onClick}
        aria-expanded={!collapsed}
      >
        <span className="truncate">{label}</span>
        <span
          className={`i-lucide:chevron-down text-xs opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100 ${
            collapsed ? '-rotate-90' : ''
          }`}
          aria-hidden
        />
      </button>
      {onAdd && (
        <button
          type="button"
          className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ema-text-tertiary)] opacity-0 transition-opacity hover:text-[var(--ema-text-primary)] focus:outline-none group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label="新建项目"
          title="新建项目"
          onClick={onAdd}
        >
          <span className="i-lucide:plus text-sm" aria-hidden />
        </button>
      )}
    </div>
  );
}
