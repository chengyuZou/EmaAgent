/**
 * useChatHistoryScroll — auto-scroll-to-bottom with user-scroll detection.
 *
 * Adapted from AIRI's `stage-ui/src/chat/composables/use-chat-history-scroll.ts`.
 */
import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';

export interface ChatHistoryScrollResult {
  /** Force scroll to bottom (called on new messages). */
  scrollToBottom: (smooth?: boolean) => void;
  /** Whether the user has manually scrolled away from the bottom. Reactive — triggers re-render. */
  userScrolled: boolean;
  /** Scroll back to bottom and clear userScrolled flag. */
  resetUserScrolled: () => void;
}

export function useChatHistoryScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  /** Dependencies that trigger auto-scroll (e.g. messages, streamingMessage). */
  deps: unknown[],
  /**
   * When these change (e.g. activeSessionId), force-reset the user-scroll flag
   * and jump to bottom — regardless of whether the user had scrolled away.
   * Must be listed BEFORE the auto-scroll effect so the reset happens first.
   */
  resetDeps?: unknown[],
): ChatHistoryScrollResult {
  // ref for use inside event handlers (avoids stale closures)
  const userScrolledRef = useRef(false);
  const isNearBottomRef = useRef(true);
  // state copy drives re-renders so the "scroll to bottom" badge appears/disappears
  const [userScrolled, setUserScrolled] = useState(false);

  const isNearBottom = useCallback((el: HTMLDivElement): boolean => {
    const threshold = 100; // px from bottom
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Listen to scroll events — update both ref and state
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (): void => {
      const near = isNearBottom(el);
      isNearBottomRef.current = near;
      const scrolledAway = !near;
      if (userScrolledRef.current !== scrolledAway) {
        userScrolledRef.current = scrolledAway;
        setUserScrolled(scrolledAway);
      }
    };

    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [containerRef, isNearBottom]);

  // Force-reset user-scroll state on session switch (or any resetDeps change).
  // Runs BEFORE the auto-scroll effect so the flag is clear when auto-scroll fires.
  useEffect(() => {
    if (!resetDeps || resetDeps.length === 0) return;
    userScrolledRef.current = false;
    isNearBottomRef.current = true;
    setUserScrolled(false);
  }, resetDeps); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll when deps change (new message or streaming delta)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const timer = setTimeout(() => {
      if (!userScrolledRef.current || isNearBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
        userScrolledRef.current = false;
        setUserScrolled(false);
      }
    }, 50);

    return () => clearTimeout(timer);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const el = containerRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
      userScrolledRef.current = false;
      setUserScrolled(false);
    },
    [containerRef],
  );

  const resetUserScrolled = useCallback(() => {
    scrollToBottom(true);
  }, [scrollToBottom]);

  return { scrollToBottom, userScrolled, resetUserScrolled };
}
