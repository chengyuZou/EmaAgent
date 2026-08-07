// 提供可自动增高并支持内嵌操作按钮的多行文本输入组件。
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import type { ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── Textarea ────────────────────────────────────────────────────────────────
// 多行文本输入,支持:
//   - 自动增高(高度随内容增长,上限 maxRows)
//   - embeddedAction 插槽——绝对定位于输入框右下角的 ReactNode,
//     即 ChatInput 的圆形发送按钮。按钮渲染在与 textarea 同级的 div 中
//     (textarea 不能包含子元素),并通过右下角 padding 预留空间避免文字重叠。

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Right-bottom corner inset slot (e.g. circular send button). */
  embeddedAction?: ReactNode;
  /** Enable height-tracks-content. Default true. */
  autoGrow?:       boolean;
  /** Cap for auto-grow rows. Beyond this, internal scroll kicks in. Default 8. */
  maxRows?:        number;
  /** Min rows shown before any content. Default 3. */
  minRows?:        number;
  error?:          boolean;
  /** Skip the outer border/bg/focus-within wrapper - render only textarea + embeddedAction
   *  in a bare relative div. For composite containers (e.g. ChatInput's input box with
   *  drag-drop + attachments) where the caller already provides the visual container. */
  containerless?:  boolean;
}

// 反向 ref handle for callers that want to imperatively focus / clear
export interface TextareaHandle {
  focus(): void;
  blur():  void;
  clear(): void;
  el():    HTMLTextAreaElement | null;
}

export const Textarea = forwardRef<TextareaHandle, TextareaProps>(
  function Textarea(props, ref) {
    const {
      embeddedAction,
      autoGrow = true,
      maxRows  = 8,
      minRows  = 3,
      error,
      containerless = false,
      className,
      value,
      onChange,
      onInput,
      style,
      ...rest
    } = props;

    const innerRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const resizeFrameRef = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      focus: () => innerRef.current?.focus(),
      blur:  () => innerRef.current?.blur(),
      clear: () => {
        const el = innerRef.current;
        if (!el) return;
        // Direct .value mutation is ignored by React for controlled inputs.
        // Using the native prototype setter + synthetic input event triggers
        // React's onChange so both controlled and uncontrolled callers get ''.
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, 'value',
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.value = '';
        }
      },
      el:    () => innerRef.current,
    }), []);

    const recomputeHeight = useCallback((): void => {
      const el = innerRef.current;
      if (!el) return;

      // 先恢复自然高度，读取完整内容高度后再限制在配置的行数范围内。
      el.style.height = 'auto';
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 22;
      const minHeight = lineHeight * minRows;
      const maxHeight = lineHeight * maxRows;
      const naturalHeight = el.scrollHeight;
      const nextHeight = Math.min(maxHeight, Math.max(minHeight, naturalHeight));

      el.style.height = `${nextHeight}px`;
      el.style.overflowY = naturalHeight > maxHeight ? 'auto' : 'hidden';
    }, [maxRows, minRows]);

    const scheduleHeightRecompute = useCallback((): void => {
      if (!autoGrow || resizeFrameRef.current !== null) return;

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        recomputeHeight();
      });
    }, [autoGrow, recomputeHeight]);

    // 内容变化在浏览器绘制前完成测量，避免先显示旧高度再跳动。
    useLayoutEffect(() => {
      if (autoGrow) recomputeHeight();
    }, [autoGrow, recomputeHeight, value]);

    // 只观察外层容器的宽度变化。写入 textarea 高度不会反向触发该观察链。
    useEffect(() => {
      if (!autoGrow) return;
      const container = containerRef.current;
      if (!container) return;

      let observedWidth = container.getBoundingClientRect().width;
      const observer = new ResizeObserver((entries) => {
        const nextWidth = entries[0]?.contentRect.width ?? observedWidth;
        if (nextWidth === observedWidth) return;

        observedWidth = nextWidth;
        scheduleHeightRecompute();
      });

      observer.observe(container);
      return () => {
        observer.disconnect();
        if (resizeFrameRef.current !== null) {
          cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
      };
    }, [autoGrow, scheduleHeightRecompute]);

    // Reserve room for action (~44px wide + 16px padding on right + 12px bottom)
    const reserveAction = embeddedAction ? { paddingRight: 52, paddingBottom: 48 } : null;

    const textareaEl = (
      <textarea
        ref={innerRef}
        aria-invalid={error || undefined}
        value={value}
        onChange={onChange}
        onInput={(event) => {
          scheduleHeightRecompute();
          onInput?.(event);
        }}
        rows={minRows}
        className={cn(
          containerless
            ? 'block w-full resize-none bg-transparent outline-none focus:outline-none'
            : 'block w-full resize-none rounded-md bg-transparent px-3 py-2.5 text-sm text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)] outline-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        style={containerless ? style : { ...reserveAction, ...style }}
        {...rest}
      />
    );

    const actionSlot = embeddedAction ? (
      <div className="pointer-events-none absolute bottom-3 right-3">
        <div className="pointer-events-auto">{embeddedAction}</div>
      </div>
    ) : null;

    if (containerless) {
      return (
        <div ref={containerRef} className="relative">
          {textareaEl}
          {actionSlot}
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className={cn(
          'relative rounded-md border bg-[var(--ema-surface-2)] transition-ema',
          'focus-within:border-[var(--ema-primary)] focus-within:ring-2 focus-within:ring-[var(--ema-primary)]/40',
          error
            ? 'border-[var(--ema-danger)] focus-within:ring-[var(--ema-danger)]/40 focus-within:border-[var(--ema-danger)]'
            : 'border-[var(--ema-border)] hover:border-[var(--ema-border-hover)]',
        )}
      >
        {textareaEl}
        {actionSlot}
      </div>
    );
  },
);
