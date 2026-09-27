// 光标跟随的 3D 倾斜全息卡: mousemove 直写行内 transform 与 CSS 变量,
// 不经过 React 状态, 高频手势下零重渲染. 入场动画类(如 ema-stagger-in)必须挂在
// 外层元素上: CSS 动画的 fill 会压住行内 transform, 同元素倾斜会失效.
import { useRef, type CSSProperties, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../utils/cn.js';

export interface CursorFloatingProps extends HTMLAttributes<HTMLDivElement> {
  /** 倾斜/放大/光泽的统一强度, 1.5 是默认手感. */
  intensity?: number;
  children: ReactNode;
}

export function CursorFloating(props: CursorFloatingProps): React.JSX.Element {
  const { intensity = 1.5, className, style, onMouseMove, onMouseLeave, children, ...rest } = props;
  const cardRef = useRef<HTMLDivElement>(null);

  function handleMouseMove(event: MouseEvent<HTMLDivElement>): void {
    onMouseMove?.(event);
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (width === 0 || height === 0) return;

    // 百分比从右/下边缘起算, 倾斜角与两层光泽位置同源于这一个坐标.
    const xPercent = Math.abs(Math.floor((100 / width) * x) - 100);
    const yPercent = Math.abs(Math.floor((100 / height) * y) - 100);

    const leftPos = 50 + (xPercent - 50) / 1.5;
    const topPos = 50 + (yPercent - 50) / 1.5;
    const rotateY = ((leftPos - 50) / 1.5) * 0.2 * intensity;
    const rotateX = ((topPos - 50) / 2) * -0.2 * intensity;
    const grow = 1 + 0.015 * intensity;
    const sparkleOpacity = 0.5 + Math.abs((50 - xPercent) + (50 - yPercent)) * 0.008 * intensity;

    card.style.transform = `perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(${grow}, ${grow}, ${grow})`;
    card.style.setProperty('--cf-x', `${leftPos}%`);
    card.style.setProperty('--cf-y', `${topPos}%`);
    card.style.setProperty('--cf-sx', `${50 + (xPercent - 50) / 7}%`);
    card.style.setProperty('--cf-sy', `${50 + (yPercent - 50) / 7}%`);
    card.style.setProperty('--cf-sparkle-opacity', `${sparkleOpacity}`);
  }

  function handleMouseLeave(event: MouseEvent<HTMLDivElement>): void {
    onMouseLeave?.(event);
    const card = cardRef.current;
    if (!card) return;
    card.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    card.style.setProperty('--cf-x', '50%');
    card.style.setProperty('--cf-y', '50%');
    card.style.setProperty('--cf-sx', '50%');
    card.style.setProperty('--cf-sy', '50%');
    card.style.setProperty('--cf-sparkle-opacity', '0.5');
  }

  return (
    <div
      ref={cardRef}
      className={cn('ema-cursor-floating', className)}
      style={{ '--cf-intensity': intensity, ...style } as CSSProperties}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      {...rest}
    >
      {children}
    </div>
  );
}
