// 管理聊天历史的自动跟随、用户上滚状态和回到底部。
import { useRef, useState, useCallback, useEffect } from 'react';

export function useChatHistoryScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  scrollDeps: readonly unknown[],
  resetDeps: readonly unknown[],
): { userScrolled: boolean; resetUserScrolled(): void } {
  const [userScrolled, setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);

  function scrollToBottom(): void {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // 切换 Session 时必须回到热尾，不能继承前一个会话的滚动位置。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    userScrolledRef.current = false;
    setUserScrolled(false);
    scrollToBottom();
  }, resetDeps);

  // 用户主动查看旧消息时停止抢夺滚动位置。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!userScrolledRef.current) scrollToBottom();
  }, scrollDeps);

  // 距离底部超过 50px 才视为主动上滚，避免小数像素抖动。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onScroll(): void {
      const distFromBottom = el!.scrollHeight - el!.clientHeight - el!.scrollTop;
      const scrolledUp = distFromBottom > 50;
      userScrolledRef.current = scrolledUp;
      setUserScrolled(scrolledUp);
    }

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const resetUserScrolled = useCallback(() => {
    userScrolledRef.current = false;
    setUserScrolled(false);
    scrollToBottom();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return { userScrolled, resetUserScrolled };
}
