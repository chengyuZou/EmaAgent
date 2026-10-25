import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';

type ReadingAnchor = {
  readonly messageId: string;
  /** scrollTop - row.start; the top inset can leave the anchor below the edge, making this negative. */
  readonly offsetPx: number;
};
type NavigationTarget =
  | { readonly kind: 'message'; readonly messageId: string }
  // started prevents restarting a native animation on every measurement commit.
  | { readonly kind: 'latest'; readonly smooth: boolean; started: boolean };

interface MessageViewportInput {
  readonly messages: readonly { readonly id: string }[];
  readonly scroller: HTMLDivElement | null;
  /** Changes when replacing the history window, but stays stable during pagination and live updates. */
  readonly windowKey: string;
  /** Initial/window replacement loading is not ready; pagination keeps the current window ready. */
  readonly ready: boolean;
  /** False when a newer page still separates this window from the latest messages. */
  readonly reachesLatest: boolean;
  /** Applied once per windowKey, rather than restarting navigation on ordinary renders. */
  readonly initialMessageId?: string;
  readonly estimateSize: (index: number) => number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
}

// The button may treat 24px as near the end; following resumes only at the actual end.
const END_THRESHOLD = 24;
const END_POSITION_TOLERANCE = 1;

export function useMessageViewport({
  messages, scroller, windowKey, ready, reachesLatest, initialMessageId,
  estimateSize, paddingStart, paddingEnd,
}: MessageViewportInput) {
  const [atBottom, setAtBottom] = useState(true);
  // Navigation lives in refs, so an explicit request still needs a React commit.
  const [, requestPositionCommit] = useState(0);
  const anchor = useRef<ReadingAnchor | null>(null);
  // Following expresses user intent; a scroll caused by measurement must not turn it on or off.
  const following = useRef(!initialMessageId);
  const navigation = useRef<NavigationTarget | null>(null);
  const currentWindow = useRef<string | null>(null);
  const previousFirstMessageId = useRef<string | undefined>(undefined);
  const userScrolling = useRef(false);
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The next scroll event subtracts this baseline. Program writes shift it by their
  // actual displacement, preserving user movement that happened before its event arrived.
  const scrollBaseline = useRef(0);

  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const scrollToFn = useCallback<typeof elementScroll<HTMLDivElement>>((offset, options, instance) => {
    const element = instance.scrollElement;
    const beforeWrite = element?.scrollTop ?? 0;
    // Native scrolling can advance between TanStack's offset callback and a resize.
    // Apply size deltas to the live position; absolute navigation keeps its requested offset.
    const baseOffset = options.adjustments !== undefined && element ? beforeWrite : offset;
    elementScroll(baseOffset, options, instance);
    if (element && options.behavior !== 'smooth') {
      scrollBaseline.current += element.scrollTop - beforeWrite;
    }
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scroller,
    getItemKey,
    estimateSize,
    scrollToFn,
    overscan: 5,
    // TanStack compensates row measurements. This hook owns prepends, navigation and follow intent.
    anchorTo: 'start',
    followOnAppend: false,
    paddingStart,
    paddingEnd,
    scrollPaddingStart: paddingStart,
    scrollPaddingEnd: paddingEnd,
  });

  function nearEnd(): boolean {
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= END_THRESHOLD;
  }

  function rememberReadingPosition(): void {
    if (!scroller) return;
    const row = virtualizer.getVirtualItemForOffset(scroller.scrollTop + paddingStart);
    if (row) anchor.current = { messageId: String(row.key), offsetPx: scroller.scrollTop - row.start };
  }

  function positionAt(offset: number): void {
    if (!scroller) return;
    const maximum = Math.max(0, virtualizer.getTotalSize() - scroller.clientHeight);
    const destination = Math.max(0, Math.min(offset, maximum));
    const applied = Math.abs(scroller.scrollTop - destination) > END_POSITION_TOLERANCE;
    if (applied) virtualizer.scrollToOffset(destination);
  }

  function updateFollowing(direction: number): void {
    if (direction < 0) {
      following.current = false;
    } else if (direction > 0 && scroller) {
      const remaining = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      following.current = reachesLatest && remaining <= END_POSITION_TOLERANCE;
    }
  }

  function stopUserScroll(): void {
    userScrolling.current = false;
    if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current = null;
  }

  function settleScroll(): void {
    stopUserScroll();
    const target = navigation.current;
    if (target?.kind !== 'latest' || !target.smooth || !target.started) return;
    // scrollToEnd targets the last item at the time of the call. If messages arrive during
    // that animation, finish at the new last item after the old animation settles.
    if (!nearEnd()) {
      target.started = false;
      requestPositionCommit(value => value + 1);
    }
  }

  function onScroll(event: Event): void {
    if (!scroller || event.target !== scroller) return;
    const scrollTop = scroller.scrollTop;
    const scrollDelta = scrollTop - scrollBaseline.current;
    scrollBaseline.current = scrollTop;
    const bottom = nearEnd();
    setAtBottom(bottom);
    // Native scrollbar gestures may omit DOM pointerdown. Movement after our synchronous
    // write is itself reading input, even without a wheel, touch or pointer event.
    if (scrollDelta !== 0 && navigation.current === null) {
      userScrolling.current = true;
      updateFollowing(scrollDelta);
      rememberReadingPosition();
    }
    if (userScrolling.current || navigation.current?.kind === 'latest') {
      if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current);
      scrollIdleTimer.current = setTimeout(settleScroll, virtualizer.options.isScrollingResetDelay);
    }
    if (navigation.current?.kind === 'latest' && navigation.current.started && bottom) {
      navigation.current = null;
    }
  }

  useLayoutEffect(() => {
    if (currentWindow.current !== windowKey) {
      stopUserScroll();
      currentWindow.current = windowKey;
      following.current = !initialMessageId;
      anchor.current = null;
      previousFirstMessageId.current = messages[0]?.id;
      navigation.current = initialMessageId
        ? { kind: 'message', messageId: initialMessageId }
        : { kind: 'latest', smooth: false, started: false };
    }
    if (!ready || !scroller) return;
    const previousFirst = previousFirstMessageId.current;
    const prependedOlderMessages = previousFirst !== undefined
      && messages[0]?.id !== previousFirst
      && messages.some(message => message.id === previousFirst);
    previousFirstMessageId.current = messages[0]?.id;
    if (messages.length === 0) {
      navigation.current = null;
      return;
    }

    const target = navigation.current;
    if (!target && userScrolling.current && !following.current && !prependedOlderMessages) {
      // First measurements already preserve reading. Refresh the anchor for real scrolling,
      // but do not replace the pre-insertion anchor before restoring a newly prepended page.
      rememberReadingPosition();
      setAtBottom(nearEnd());
      return;
    }
    if (target?.kind === 'message') {
      const index = Math.max(0, messages.findIndex(message => message.id === target.messageId));
      const row = virtualizer.measurementsCache[index];
      if (!row) return;
      positionAt(row.start - paddingStart);
      // Keep the target until it mounts, so estimate changes cannot finish navigation early.
      const messageId = String(row.key);
      anchor.current = { messageId, offsetPx: -paddingStart };
      if (virtualizer.elementsCache.has(messageId)) {
        navigation.current = null;
      }
    } else if (target?.kind === 'latest' && target.smooth) {
      if (!target.started) {
        target.started = true;
        virtualizer.scrollToEnd({ behavior: 'smooth' });
      }
      if (nearEnd()) {
        navigation.current = null;
      }
    } else {
      let offset: number | undefined;
      if (target?.kind === 'latest' || (following.current && (reachesLatest || !anchor.current))) {
        offset = virtualizer.getTotalSize() - scroller.clientHeight;
      } else if (anchor.current) {
        const index = messages.findIndex(message => message.id === anchor.current!.messageId);
        const row = virtualizer.measurementsCache[index];
        if (row) {
          // Collapsing the anchor row can make it shorter than the saved reading offset.
          const withinRow = Math.min(anchor.current.offsetPx, Math.max(0, row.size - paddingStart));
          offset = row.start + withinRow;
        }
      }
      if (offset !== undefined) {
        positionAt(offset);
        if (!reachesLatest && following.current) {
          // An older window opens at its own end once; later pages must preserve reading.
          following.current = false;
          rememberReadingPosition();
        }
        navigation.current = null;
      }
    }
    setAtBottom(nearEnd());
  });

  useEffect(() => {
    if (!scroller) return;
    const takeControl = (): void => {
      if (navigation.current) {
        navigation.current = null;
        virtualizer.scrollToOffset(scroller.scrollTop);
      }
      updateFollowing(scroller.scrollTop - scrollBaseline.current);
      scrollBaseline.current = scroller.scrollTop;
      userScrolling.current = true;
      rememberReadingPosition();
    };
    const wheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      takeControl();
      // The compositor may already have moved before wheel arrives. Its direction still
      // expresses intent when the later scroll event has no unaccounted displacement.
      updateFollowing(event.deltaY);
    };
    const pointer = (event: PointerEvent): void => {
      const scrollbarWidth = Math.max(16, scroller.offsetWidth - scroller.clientWidth);
      if (event.clientX < scroller.getBoundingClientRect().right - scrollbarWidth) return;
      takeControl();
    };
    const keyboard = (event: KeyboardEvent): void => {
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      if ((event.target as Element).closest('input, textarea, select, button, [contenteditable="true"]')) return;
      takeControl();
      following.current = false;
    };
    scroller.addEventListener('wheel', wheel, { passive: true });
    scroller.addEventListener('touchmove', takeControl, { passive: true });
    scroller.addEventListener('pointerdown', pointer);
    scroller.addEventListener('keydown', keyboard);
    // TanStack's bubbling listener can flushSync. Capture must update the reading anchor first.
    scroller.addEventListener('scroll', onScroll, { capture: true, passive: true });
    scroller.addEventListener('scrollend', settleScroll);
    return () => {
      stopUserScroll();
      scroller.removeEventListener('wheel', wheel);
      scroller.removeEventListener('touchmove', takeControl);
      scroller.removeEventListener('pointerdown', pointer);
      scroller.removeEventListener('keydown', keyboard);
      scroller.removeEventListener('scroll', onScroll, true);
      scroller.removeEventListener('scrollend', settleScroll);
    };
  }, [scroller, virtualizer, paddingStart, reachesLatest]);

  function scrollToMessage(messageId: string): void {
    stopUserScroll();
    following.current = false;
    navigation.current = { kind: 'message', messageId };
    requestPositionCommit(value => value + 1);
  }

  function scrollToLatest(smooth = false): void {
    stopUserScroll();
    following.current = true;
    navigation.current = { kind: 'latest', smooth, started: false };
    requestPositionCommit(value => value + 1);
  }

  function isPositioning(): boolean {
    return currentWindow.current !== windowKey || navigation.current !== null;
  }

  return { virtualizer, atBottom, scrollToMessage, scrollToLatest, isPositioning };
}
