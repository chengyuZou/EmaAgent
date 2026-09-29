// 消息窗口保留展开选择; 非虚拟化的独立子代理面板使用本地状态.
import { createContext, useContext, useLayoutEffect, useState, type Dispatch, type SetStateAction } from 'react';

export const MessageExpansionContext = createContext<Map<string, boolean> | null>(null);

export function useMessageExpansion(
  sectionKey: string,
  initiallyOpen = false,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  const choices = useContext(MessageExpansionContext);
  const [open, setOpen] = useState(() => choices?.get(sectionKey) ?? initiallyOpen);
  useLayoutEffect(
    () => { 
      choices?.set(sectionKey, open); 
    }, [choices, sectionKey, open]);
  return [open, setOpen];
}
