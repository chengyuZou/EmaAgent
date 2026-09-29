// 渲染项目分区、项目操作与成员会话。
import { useEffect, useState, type JSX } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  IconButton,
  Input,
  Tooltip,
  type MenuItem,
} from '@ema-agent/ui';
import type { Project, SessionListItem } from '../../api/sessions.js';
import { projectsApi } from '../../api/workspaces.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { runWithToast } from '../../lib/toast.js';
import type { SessionActivity } from '../../stores/sessionActivity.js';
import { useSessionStore } from '../../stores/session.js';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { SessionRow } from './SessionRow.js';
import { useSidebarDrag } from './SidebarDragContext.js';

interface ProjectSectionProps {
  projects: Project[];
  viewedId: string | null;
  activityBySession: ReadonlyMap<string, SessionActivity>;
}

const PROJECT_DIALOG_CLASSES =
  '!p-[20px] [&_h2]:!text-[20px] [&_h2]:pr-[28px] ' +
  '[&>button]:!h-[28px] [&>button]:!w-[28px]';

function projectFolderLabel(path: string, paths: readonly string[]): string {
  const folderName = (value: string): string =>
    value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? value;
  const name = folderName(path);
  if (paths.some((other) => other !== path && folderName(other) === name)) {
    const parent = path.replace(/[\\/]+$/, '').slice(0, -name.length);
    return `${name} · ${parent}`;
  }
  return name;
}

function ProjectFolderRow({
  path,
  label,
  primary,
  onSetPrimary,
  onRemove,
}: {
  path: string;
  label: string;
  primary: boolean;
  onSetPrimary(): void;
  onRemove(): void;
}): JSX.Element {
  return (
    <div className="flex min-h-[48px] items-center gap-[12px] border-b border-[var(--ema-border)] px-[12px] py-[8px] text-[14px] text-[var(--ema-text-primary)]">
      <span className="i-lucide:folder shrink-0 text-[16px] text-[var(--ema-text-tertiary)]" aria-hidden />
      <Tooltip
        variant="card"
        align="start"
        content={<span className="break-all font-mono">{path}</span>}
      >
        <span tabIndex={0} className="min-w-0 flex-1 truncate rounded-sm focus-ring">
          {label}
        </span>
      </Tooltip>
      <div className="flex w-[76px] shrink-0 justify-end">
        {primary ? (
          <span className="inline-flex h-[28px] items-center rounded-md border border-[var(--ema-border)] px-[8px] text-[13px] text-[var(--ema-text-secondary)]">
            主要
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="!h-[28px] !border-[var(--ema-border)] !px-[8px] !text-[13px]"
            onClick={onSetPrimary}
          >
            设为主要
          </Button>
        )}
      </div>
      <Tooltip content="移除文件夹">
        <IconButton
          variant="ghost"
          shape="rounded"
          size="sm"
          className="!h-[28px] !w-[28px] shrink-0"
          icon="i-lucide:x"
          label={`移除源文件夹 ${path}`}
          onClick={onRemove}
        />
      </Tooltip>
    </div>
  );
}

export function PinnedSection({
  projects,
  sessions,
  viewedId,
  activityBySession,
}: {
  projects: Project[];
  sessions: SessionListItem[];
  viewedId: string | null;
  activityBySession: ReadonlyMap<string, SessionActivity>;
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const drag = useSidebarDrag();
  const projectEndDropProps = drag.projectTargetProps('pinned-projects-end', 'pinned', null);
  const sessionEndDropProps = drag.sessionTargetProps(
    'pinned-sessions-end',
    { section: 'pinned' },
    null,
  );

  useEffect(() => {
    if (drag.dragged) setCollapsed(false);
  }, [drag.dragged]);

  if (projects.length === 0 && sessions.length === 0 && !drag.dragged) return null;

  return (
    <section className="mb-2">
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
              section="pinned"
              viewedId={viewedId}
              activityBySession={activityBySession}
            />
          ))}
          <div
            className={`ema-sidebar-drop-zone ema-drop-end ${drag.dragged?.kind === 'project' ? 'ema-drop-ready' : ''}`}
            {...projectEndDropProps}
          />
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === viewedId}
              activityBySession={activityBySession}
              dropDestination={{ section: 'pinned' }}
            />
          ))}
          <div
            className={`ema-sidebar-drop-zone ema-drop-end ${drag.dragged?.kind === 'session' ? 'ema-drop-ready' : ''}`}
            {...sessionEndDropProps}
          />
        </div>
      </Collapse>
    </section>
  );
}

export function ProjectSection({
  projects,
  viewedId,
  activityBySession,
}: ProjectSectionProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const drag = useSidebarDrag();
  const endDropProps = drag.projectTargetProps('projects-end', 'projects', null);

  useEffect(() => {
    if (drag.dragged?.kind === 'project') setCollapsed(false);
  }, [drag.dragged]);

  return (
    <section className="mb-2">
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
                section="projects"
                viewedId={viewedId}
                activityBySession={activityBySession}
              />
            ))
          )}
          <div
            className={`ema-sidebar-drop-zone ema-drop-end ${drag.dragged?.kind === 'project' ? 'ema-drop-ready' : ''}`}
            {...endDropProps}
          />
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
          ...(primaryFolderPath ? { primaryFolderPath } : {}),
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
      widthClass="max-w-[520px]"
      className={PROJECT_DIALOG_CLASSES}
    >
      <div className="relative">
        <span
          className="i-lucide:folder pointer-events-none absolute left-[12px] top-1/2 -translate-y-1/2 text-[16px] text-[var(--ema-text-tertiary)]"
          aria-hidden
        />
        <Input
          aria-label="项目名称"
          mono={false}
          className="!h-[40px] !pl-[40px] !text-[14px]"
          placeholder="项目名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </div>
      <p className="mb-[8px] mt-[16px] text-[14px] text-[var(--ema-text-secondary)]">
        源文件夹
      </p>
      <div className="overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-3)]">
        {folderPaths.map((path) => (
          <ProjectFolderRow
            key={path}
            path={path}
            label={projectFolderLabel(path, folderPaths)}
            primary={primaryFolderPath === path}
            onSetPrimary={() => setPrimaryFolderPath(path)}
            onRemove={() => removeFolder(path)}
          />
        ))}
        <button
          type="button"
          className={`flex w-full cursor-pointer items-center gap-[12px] px-[12px] py-[8px] text-left text-[14px] text-[var(--ema-text-primary)] transition-ema hover:bg-[var(--ema-surface-2)] focus-ring ${
            folderPaths.length === 0 ? 'min-h-[96px] flex-col justify-center' : 'min-h-[48px]'
          }`}
          onClick={() => void pickFolder()}
        >
          <span className="i-lucide:folder-plus shrink-0 text-[16px] text-[var(--ema-text-secondary)]" aria-hidden />
          <span>
            {folderPaths.length === 0
              ? '添加可读取和编辑的文件夹'
              : '添加文件夹'}
          </span>
        </button>
      </div>
      <div className="mt-[20px] flex justify-end gap-[12px]">
        <Button variant="ghost" className="!h-[36px] !text-[14px]" onClick={onClose}>
          取消
        </Button>
        <button
          type="button"
          className="h-[36px] rounded-lg bg-[var(--ema-text-primary)] px-[16px] text-[14px] font-medium text-[var(--ema-bg)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
          disabled={!name.trim() || saving}
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
  section,
  viewedId,
  activityBySession,
}: {
  project: Project;
  section: 'pinned' | 'projects';
  viewedId: string | null;
  activityBySession: ReadonlyMap<string, SessionActivity>;
}): JSX.Element {
  const active = project.sessions.some((session) => session.id === viewedId);
  const [collapsed, setCollapsed] = useState(!active);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const drag = useSidebarDrag();
  const rowDropProps = drag.dragged?.kind === 'session'
    ? drag.sessionTargetProps(
      `project-session-end:${project.id}`,
      { section: 'project', projectId: project.id },
      null,
    )
    : drag.projectTargetProps(`project-before:${project.id}`, section, project.id);

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
        draggable
        data-dragging={drag.dragged?.kind === 'project' && drag.dragged.id === project.id || undefined}
        className={`ema-sidebar-item ema-project-row ${drag.dragged?.kind === 'session' ? 'ema-drop-inside' : 'ema-drop-before'} group flex h-[34px] w-full items-center gap-1 rounded-lg border border-transparent px-1 text-sm font-normal text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]`}
        onDragStart={(event) => drag.startProject(event, project.id)}
        onDragEnd={drag.endDrag}
        {...rowDropProps}
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left focus:outline-none"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <span
            className={`text-base text-[var(--ema-warning)] ${
              collapsed ? 'i-lucide:folder' : 'i-lucide:folder-open'
            }`}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {project.name}
          </span>
        </button>
        <IconButton
          size="sm"
          className="ema-chat-row-action"
          icon="i-lucide:square-pen"
          label={`在 ${project.name} 中新建对话`}
          onClick={() => useChatNavigationStore.getState().openNewSession(project.id)}
        />
        <DropdownMenu
          trigger={
            <IconButton
              size="sm"
              className="ema-chat-row-action"
              icon="i-lucide:more-horizontal"
              label={`${project.name} 项目菜单`}
            />
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
              activityBySession={activityBySession}
              nested
              dropDestination={{ section: 'project', projectId: project.id }}
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
                if (useChatNavigationStore.getState().newSessionProjectId === project.id) {
                  useChatNavigationStore.getState().openNewSession();
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

  const folderPaths = project.folders.map((folder) => folder.path);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="编辑项目"
      widthClass="max-w-[520px]"
      className={PROJECT_DIALOG_CLASSES}
    >
      <div className="flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <span
            className="i-lucide:folder pointer-events-none absolute left-[12px] top-1/2 -translate-y-1/2 text-[16px] text-[var(--ema-text-tertiary)]"
            aria-hidden
          />
          <Input
            id={`project-name-${project.id}`}
            aria-label="项目名称"
            mono={false}
            className="!h-[40px] !pl-[40px] !text-[14px]"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button
          variant="primary"
          className="!h-[40px] shrink-0 !px-[16px] !text-[14px]"
          disabled={!name.trim() || name.trim() === project.name}
          onClick={() => void change(
            projectsApi.patch(project.id, name.trim()),
            '项目重命名失败',
          )}
        >
          保存
        </Button>
      </div>
      <p className="mb-[8px] mt-[16px] text-[14px] text-[var(--ema-text-secondary)]">
        源文件夹
      </p>
      <div className="overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-3)]">
        {project.folders.map((folder) => (
          <ProjectFolderRow
            key={folder.path}
            path={folder.path}
            label={projectFolderLabel(folder.path, folderPaths)}
            primary={folder.isPrimary}
            onSetPrimary={() => void change(
              projectsApi.setPrimaryFolder(project.id, folder.path),
              '设置主文件夹失败',
            )}
            onRemove={() => void change(
              projectsApi.removeFolder(project.id, folder.path),
              '移除源文件夹失败',
            )}
          />
        ))}
        <button
          type="button"
          className="flex min-h-[48px] w-full cursor-pointer items-center gap-[12px] px-[12px] py-[8px] text-left text-[14px] text-[var(--ema-text-primary)] transition-ema hover:bg-[var(--ema-surface-2)] focus-ring"
          onClick={() => void addFolder()}
        >
          <span className="i-lucide:folder-plus shrink-0 text-[16px] text-[var(--ema-text-secondary)]" aria-hidden />
          添加文件夹
        </button>
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
    <div className="group mx-1.5 mb-0.5 flex h-7 items-center text-[var(--ema-text-tertiary)]">
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
        <IconButton
          size="sm"
          className="ema-chat-row-action mr-1"
          icon="i-lucide:plus"
          label="新建项目"
          onClick={onAdd}
        />
      )}
    </div>
  );
}
