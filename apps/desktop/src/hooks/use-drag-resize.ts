// 拖拽调栏宽的统一手柄：pointer capture 跟随单元素、rAF 节流写尺寸；
// 每次手势以起手时的渲染尺寸为基准（快速反复起手不回弹）。
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface DragResizeOptions {
  /** 尺寸沿哪个轴变化：'x' 调宽、'y' 调高。 */
  axis: 'x' | 'y';
  /** +1 = 指针正向移动增大尺寸；-1 = 反向（手柄在对侧边缘）。 */
  sign: 1 | -1;
  getSize(): number;
  setSize(size: number): void;
  min: number;
  max: number;
}

export interface DragResizeHandle {
  resizing: boolean;
  handleProps: {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  };
}

export function useDragResize({
  axis, sign, getSize, setSize, min, max,
}: DragResizeOptions): DragResizeHandle {
  const [resizing, setResizing] = useState(false);
  const rafRef = useRef(0);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault();
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    setResizing(true);

    const startPos = axis === 'x' ? event.clientX : event.clientY;
    const startSize = getSize();

    const onMove = (ev: PointerEvent): void => {
      if (rafRef.current !== 0) return;
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const next = startSize + (pos - startPos) * sign;
        setSize(Math.max(min, Math.min(max, next)));
      });
    };
    const onUp = (ev: PointerEvent): void => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      setResizing(false);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [axis, sign, getSize, setSize, min, max]);

  return { resizing, handleProps: { onPointerDown } };
}
