import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * Tracks scroll position for a chat history container.
 *
 * - Auto-scrolls to bottom whenever `scrollDeps` change, unless the user has
 *   manually scrolled up (userScrolled = true).
 * - Resets scroll state (forces bottom) whenever `resetDeps` change (e.g. session switch).
 * - Returns `userScrolled` to show/hide the "scroll to bottom" button, and
 *   `resetUserScrolled` to jump back to bottom on button click.
 */
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

  // Force bottom + clear flag on session switch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    userScrolledRef.current = false;
    setUserScrolled(false);
    scrollToBottom();
  }, resetDeps);

  // Auto-scroll when messages or streaming state changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!userScrolledRef.current) scrollToBottom();
  }, scrollDeps);

  // Detect manual upward scroll
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
  }, []); // container element is stable after mount

  const resetUserScrolled = useCallback(() => {
    userScrolledRef.current = false;
    setUserScrolled(false);
    scrollToBottom();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return { userScrolled, resetUserScrolled };
}
