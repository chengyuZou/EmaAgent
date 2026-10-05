// 根消息窗口和子代理虚拟列表保留展开选择; 未提供 Context 的独立渲染使用本地状态.
import { createContext, useContext, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

export const MessageExpansionContext = createContext<Map<string, boolean> | null>(null);

export function useMessageExpansion(sectionKey: string, initiallyOpen = false): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  const choices = useContext(MessageExpansionContext);
  const [open, setOpen] = useState(() => choices?.get(sectionKey) ?? initiallyOpen);
  useLayoutEffect(() => {
    choices?.set(sectionKey, open);
  }, [choices, sectionKey, open]);
  return [open, setOpen];
}

/** 正文展开才挂载, 收起等实际 CSS 过渡结束再卸载; 重开使旧收尾失效. */
export function useCollapsibleBody(open: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(open);
  const mounted = open || retained;

  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;

    const transitions = containerRef.current?.getAnimations().filter(animation => (
      animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-rows'
    )) ?? [];
    if (transitions.length === 0) {
      setRetained(false);
      return;
    }

    let cancelled = false;
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (!cancelled) setRetained(false);
    });
    return () => { cancelled = true; };
  }, [open, retained]);

  return { containerRef, mounted };
}
