import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ProjectSidebarMoveInput,
  SessionSidebarMoveInput,
} from '../../api/workspaces.js';
import { runWithToast } from '../../lib/notifications/toast.js';
import { useSessionStore } from '../../stores/session.js';

type DraggedItem =
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string };

interface DropTarget {
  key: string;
  acceptedKind: DraggedItem['kind'];
  rejectedId: string | null;
  move(id: string): Promise<void>;
}

interface DropTargetProps {
  ref(element: HTMLElement | null): void;
  'data-drop-active'?: true;
  'data-drop-complete'?: true;
}

interface PointerDrag {
  item: DraggedItem;
  label: string;
  pointerId: number;
  source: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
}

interface SidebarDragValue {
  dragged: DraggedItem | null;
  startSession(event: ReactPointerEvent<HTMLElement>, sessionId: string, label: string): void;
  startProject(event: ReactPointerEvent<HTMLElement>, projectId: string, label: string): void;
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
  const [preview, setPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  const gesture = useRef<PointerDrag | null>(null);
  const targets = useRef(new Map<HTMLElement, DropTarget>());
  const scrollFrame = useRef<number | null>(null);
  const completedTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);

  function targetAt(x: number, y: number, item: DraggedItem): DropTarget | null {
    let element = document.elementFromPoint(x, y);
    while (element) {
      const target = targets.current.get(element as HTMLElement);
      if (target) {
        if (target.acceptedKind === item.kind && target.rejectedId !== item.id) return target;
        return null;
      }
      element = element.parentElement;
    }
    return null;
  }

  function endDrag(): void {
    const current = gesture.current;
    gesture.current = null;
    if (scrollFrame.current !== null) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
    if (current?.source.hasPointerCapture(current.pointerId)) {
      current.source.releasePointerCapture(current.pointerId);
    }
    setDragged(null);
    setPreview(null);
    setTargetKey(null);
  }

  function scrollDuringDrag(): void {
    const current = gesture.current;
    if (!current?.active) return;
    const scroll = current.source.closest<HTMLElement>('[data-sidebar-scroll]');
    if (scroll) {
      const bounds = scroll.getBoundingClientRect();
      let delta = 0;
      if (current.x >= bounds.left && current.x < bounds.right) {
        if (current.y >= bounds.top && current.y < bounds.top + 32) delta = -8;
        else if (current.y < bounds.bottom && current.y > bounds.bottom - 32) delta = 8;
      }
      if (delta !== 0) {
        scroll.scrollTop += delta;
        setTargetKey(targetAt(current.x, current.y, current.item)?.key ?? null);
      }
    }
    scrollFrame.current = window.requestAnimationFrame(scrollDuringDrag);
  }

  function begin(event: ReactPointerEvent<HTMLElement>, item: DraggedItem, label: string): void {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = event.target as Element;
    const control = target.closest('button, a, input, textarea, select, [role="button"]');
    if (control && !control.hasAttribute('data-sidebar-drag-handle')) return;
    endDrag();
    setCompletedKey(null);
    gesture.current = {
      item,
      label,
      pointerId: event.pointerId,
      source: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
  }

  useEffect(() => {
    function move(event: PointerEvent): void {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if ((event.buttons & 1) === 0) {
        endDrag();
        return;
      }
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.active) {
        if (Math.hypot(current.x - current.startX, current.y - current.startY) < 6) return;
        current.active = true;
        suppressClick.current = true;
        current.source.setPointerCapture(current.pointerId);
        setDragged(current.item);
        scrollFrame.current = window.requestAnimationFrame(scrollDuringDrag);
      }
      event.preventDefault();
      setPreview({ label: current.label, x: current.x, y: current.y });
      setTargetKey(targetAt(current.x, current.y, current.item)?.key ?? null);
    }

    function finish(event: PointerEvent): void {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const target = current.active ? targetAt(event.clientX, event.clientY, current.item) : null;
      endDrag();
      if (!target) return;
      void runWithToast(
        target.move(current.item.id).then(() => {
          setCompletedKey(target.key);
          if (completedTimer.current !== null) window.clearTimeout(completedTimer.current);
          completedTimer.current = window.setTimeout(() => {
            setCompletedKey(null);
            completedTimer.current = null;
          }, 320);
        }),
        current.item.kind === 'session' ? '移动对话失败' : '移动项目失败',
      );
    }

    function cancelPointer(event: PointerEvent): void {
      if (gesture.current?.pointerId === event.pointerId) endDrag();
    }

    function cancelKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') endDrag();
    }

    function preventDragClick(event: MouseEvent): void {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }

    function resetClick(): void {
      suppressClick.current = false;
    }

    // 超过移动阈值才拦截点击, 保留轻点打开会话和按钮的键盘操作.
    document.addEventListener('pointerdown', resetClick, true);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('lostpointercapture', cancelPointer);
    window.addEventListener('blur', endDrag);
    window.addEventListener('keydown', cancelKey);
    document.addEventListener('click', preventDragClick, true);
    return () => {
      document.removeEventListener('pointerdown', resetClick, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('lostpointercapture', cancelPointer);
      window.removeEventListener('blur', endDrag);
      window.removeEventListener('keydown', cancelKey);
      document.removeEventListener('click', preventDragClick, true);
      endDrag();
      if (completedTimer.current !== null) window.clearTimeout(completedTimer.current);
    };
  }, []);

  function commonTarget(target: DropTarget): DropTargetProps {
    let registered: HTMLElement | null = null;
    return {
      ref(element) {
        if (registered) targets.current.delete(registered);
        registered = element;
        if (element) targets.current.set(element, target);
      },
      ...(targetKey === target.key ? { 'data-drop-active': true as const } : {}),
      ...(completedKey === target.key ? { 'data-drop-complete': true as const } : {}),
    };
  }

  const value = useMemo<SidebarDragValue>(() => ({
    dragged,
    startSession: (event, id, label) => begin(event, { kind: 'session', id }, label),
    startProject: (event, id, label) => begin(event, { kind: 'project', id }, label),
    sessionTargetProps: (key, destination, beforeSessionId) => commonTarget({
      key,
      acceptedKind: 'session',
      rejectedId: beforeSessionId,
      move: sessionId => useSessionStore.getState().moveSessionInSidebar(sessionId, {
        destination,
        beforeSessionId,
      }),
    }),
    projectTargetProps: (key, section, beforeProjectId) => commonTarget({
      key,
      acceptedKind: 'project',
      rejectedId: beforeProjectId,
      move: projectId => useSessionStore.getState().moveProjectInSidebar(projectId, {
        section,
        beforeProjectId,
      }),
    }),
  }), [completedKey, dragged, targetKey]);

  return (
    <SidebarDragContext.Provider value={value}>
      {children}
      {preview && createPortal(
        <div
          className="ema-sidebar-drag-preview"
          style={{ left: preview.x + 12, top: preview.y + 12 }}
          aria-hidden="true"
        >
          {preview.label}
        </div>,
        document.body,
      )}
    </SidebarDragContext.Provider>
  );
}

export function useSidebarDrag(): SidebarDragValue {
  const value = useContext(SidebarDragContext);
  if (!value) throw new Error('useSidebarDrag must be used inside SidebarDragProvider');
  return value;
}
