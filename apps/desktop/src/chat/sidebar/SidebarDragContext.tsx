// 管理 Sidebar 原生拖放手势，并把一次落点提交为服务端持久顺序。
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type DragEventHandler,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ProjectSidebarMoveInput,
  SessionSidebarMoveInput,
} from '../../api/workspaces.js';
import { runWithToast } from '../../lib/toast.js';
import { useSessionStore } from '../../stores/session.js';

type DraggedItem =
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string };

interface DropTargetProps {
  onDragOver?: DragEventHandler<HTMLElement>;
  onDragLeave?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
  'data-drop-active'?: true;
  'data-drop-complete'?: true;
}

interface SidebarDragValue {
  dragged: DraggedItem | null;
  startSession(event: DragEvent<HTMLElement>, sessionId: string): void;
  startProject(event: DragEvent<HTMLElement>, projectId: string): void;
  endDrag(): void;
  sessionTargetProps(
    key: string,
    destination: SessionSidebarMoveInput['destination'],
    beforeSessionId: string | null,
  ): DropTargetProps;
  projectTargetProps(
    key: string,
    section: ProjectSidebarMoveInput['section'],
    beforeProjectId: string | null,
  ): DropTargetProps;
}

const SidebarDragContext = createContext<SidebarDragValue | null>(null);

export function SidebarDragProvider({ children }: { children: ReactNode }): JSX.Element {
  const [dragged, setDragged] = useState<DraggedItem | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  const draggedItem = useRef<DraggedItem | null>(null);
  const dragVisualFrame = useRef<number | null>(null);
  const completedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (dragVisualFrame.current !== null) window.cancelAnimationFrame(dragVisualFrame.current);
    if (completedTimer.current !== null) window.clearTimeout(completedTimer.current);
  }, []);

  function begin(event: DragEvent<HTMLElement>, item: DraggedItem): void {
    draggedItem.current = item;
    setTargetKey(null);
    setCompletedKey(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${item.kind}:${item.id}`);
    if (dragVisualFrame.current !== null) window.cancelAnimationFrame(dragVisualFrame.current);
    dragVisualFrame.current = window.requestAnimationFrame(() => {
      setDragged(item);
      dragVisualFrame.current = null;
    });
  }

  function endDrag(): void {
    draggedItem.current = null;
    if (dragVisualFrame.current !== null) {
      window.cancelAnimationFrame(dragVisualFrame.current);
      dragVisualFrame.current = null;
    }
    setDragged(null);
    setTargetKey(null);
  }

  function complete(key: string): void {
    setCompletedKey(key);
    if (completedTimer.current !== null) window.clearTimeout(completedTimer.current);
    completedTimer.current = window.setTimeout(() => {
      setCompletedKey(null);
      completedTimer.current = null;
    }, 320);
  }

  function commonTarget(
    key: string,
    acceptedKind: DraggedItem['kind'],
    rejectedId: string | null,
    move: (id: string) => Promise<void>,
  ): DropTargetProps {
    return {
      onDragOver(event) {
        const current = draggedItem.current;
        if (current?.kind !== acceptedKind || current.id === rejectedId) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setTargetKey(key);
      },
      onDragLeave(event) {
        const current = draggedItem.current;
        if (current?.kind !== acceptedKind || current.id === rejectedId) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setTargetKey((current) => current === key ? null : current);
      },
      onDrop(event) {
        const current = draggedItem.current;
        if (current?.kind !== acceptedKind || current.id === rejectedId) return;
        event.preventDefault();
        event.stopPropagation();
        const movedId = current.id;
        endDrag();
        void runWithToast(
          move(movedId).then(() => complete(key)),
          acceptedKind === 'session' ? '移动对话失败' : '移动项目失败',
        );
      },
      ...(targetKey === key ? { 'data-drop-active': true as const } : {}),
      ...(completedKey === key ? { 'data-drop-complete': true as const } : {}),
    };
  }

  const value = useMemo<SidebarDragValue>(() => ({
    dragged,
    startSession: (event, sessionId) => begin(event, { kind: 'session', id: sessionId }),
    startProject: (event, projectId) => begin(event, { kind: 'project', id: projectId }),
    endDrag,
    sessionTargetProps: (key, destination, beforeSessionId) => commonTarget(
      key,
      'session',
      beforeSessionId,
      (sessionId) => useSessionStore.getState().moveSessionInSidebar(sessionId, {
        destination,
        beforeSessionId,
      }),
    ),
    projectTargetProps: (key, section, beforeProjectId) => commonTarget(
      key,
      'project',
      beforeProjectId,
      (projectId) => useSessionStore.getState().moveProjectInSidebar(projectId, {
        section,
        beforeProjectId,
      }),
    ),
  }), [completedKey, dragged, targetKey]);

  return (
    <SidebarDragContext.Provider value={value}>
      {children}
    </SidebarDragContext.Provider>
  );
}

export function useSidebarDrag(): SidebarDragValue {
  const value = useContext(SidebarDragContext);
  if (!value) throw new Error('useSidebarDrag must be used inside SidebarDragProvider');
  return value;
}
