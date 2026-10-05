// 根历史与子代理消息共用定位: 内核保存行高, 此处统一阅读锚点、显式导航和底部跟随.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';

type ReadingAnchor = { readonly messageId: string; readonly offsetPx: number };
type NavigationTarget =
  | { readonly kind: 'message'; readonly messageId: string }
  | { readonly kind: 'latest'; readonly smooth: boolean; started: boolean };

interface MessageViewportInput {
  readonly messages: readonly { readonly id: string }[];
  readonly scroller: HTMLDivElement | null;
  /** 整个历史窗口的身份, 分页和实时更新不改变它. */
  readonly windowKey: string;
  readonly ready: boolean;
  readonly reachesLatest: boolean;
  readonly initialMessageId?: string;
  readonly estimateSize: (index: number) => number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
}

const END_THRESHOLD = 24;

export function useMessageViewport({
  messages, scroller, windowKey, ready, reachesLatest, initialMessageId,
  estimateSize, paddingStart, paddingEnd,
}: MessageViewportInput) {
  const [atBottom, setAtBottom] = useState(true);
  const [, requestPositionCommit] = useState(0);
  const anchor = useRef<ReadingAnchor | null>(null);
  // 这是用户意图, 不能被程序定位产生的 scroll 事件改写.
  const following = useRef(!initialMessageId);
  const navigation = useRef<NavigationTarget | null>(null);
  const initialized = useRef(false);
  const currentWindow = useRef<string | null>(null);
  const userScrolling = useRef(false);
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticOffset = useRef<number | null>(null);

  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const scrollToFn = useCallback<typeof elementScroll>((offset, options, instance) => {
    const element = instance.scrollElement;
    const maximum = element ? Math.max(0, element.scrollHeight - element.clientHeight) : 0;
    programmaticOffset.current = Math.max(0, Math.min(offset + (options.adjustments ?? 0), maximum));
    elementScroll(offset, options, instance);
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scroller,
    getItemKey,
    estimateSize,
    scrollToFn,
    overscan: 5,
    // 不让内核的尺寸补偿、前插锚定和回底与下面的定位再执行一遍.
    anchorTo: 'start',
    followOnAppend: false,
    paddingStart,
    paddingEnd,
    scrollPaddingStart: paddingStart,
    scrollPaddingEnd: paddingEnd,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  function nearEnd(): boolean {
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= END_THRESHOLD;
  }

  function rememberReadingPosition(): void {
    if (!scroller) return;
    const row = virtualizer.getVirtualItemForOffset(scroller.scrollTop + paddingStart);
    if (row) anchor.current = { messageId: String(row.key), offsetPx: scroller.scrollTop - row.start };
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
    // 平滑途中新测量会改变末项位置. 一段原生动画结束后, 继续去当前末项, 不回到旧目标.
    if (!nearEnd()) {
      target.started = false;
      requestPositionCommit(value => value + 1);
    }
  }

  function onScroll(): void {
    if (!scroller) return;
    const bottom = nearEnd();
    setAtBottom(bottom);
    const commanded = programmaticOffset.current !== null
      && Math.abs(scroller.scrollTop - programmaticOffset.current) <= 1;
    if (commanded) programmaticOffset.current = null;
    if (userScrolling.current && !commanded) {
      following.current = bottom && reachesLatest;
      rememberReadingPosition();
    }
    if (userScrolling.current || navigation.current?.kind === 'latest') {
      if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current);
      scrollIdleTimer.current = setTimeout(settleScroll, virtualizer.options.isScrollingResetDelay);
    }
    if (navigation.current?.kind === 'latest' && navigation.current.started && bottom) {
      navigation.current = null;
      initialized.current = true;
    }
  }

  useLayoutEffect(() => {
    if (currentWindow.current !== windowKey) {
      currentWindow.current = windowKey;
      initialized.current = false;
      following.current = !initialMessageId;
      anchor.current = null;
      navigation.current = initialMessageId
        ? { kind: 'message', messageId: initialMessageId }
        : { kind: 'latest', smooth: false, started: false };
    }
    if (!ready || !scroller) return;
    if (messages.length === 0) {
      initialized.current = true;
      navigation.current = null;
      return;
    }

    const target = navigation.current;
    if (target?.kind === 'message') {
      const index = Math.max(0, messages.findIndex(message => message.id === target.messageId));
      const row = virtualizer.measurementsCache[index];
      if (!row) return;
      const offset = row.start - paddingStart;
      if (Math.abs(scroller.scrollTop - offset) > 1) virtualizer.scrollToOffset(offset);
      // 目标进入真实挂载范围后才结束导航, 后续测量继续围绕同一个 ID 补偿.
      const messageId = String(row.key);
      anchor.current = { messageId, offsetPx: -paddingStart };
      if (virtualizer.elementsCache.has(messageId)) {
        navigation.current = null;
        initialized.current = true;
      }
    } else if (target?.kind === 'latest' && target.smooth) {
      if (!target.started) {
        target.started = true;
        virtualizer.scrollToEnd({ behavior: 'smooth' });
      }
      if (nearEnd()) {
        navigation.current = null;
        initialized.current = true;
      }
    } else {
      let offset: number | undefined;
      if (target?.kind === 'latest' || (following.current && (reachesLatest || !anchor.current))) {
        offset = Math.max(0, virtualizer.getTotalSize() - scroller.clientHeight);
      } else if (anchor.current) {
        const index = messages.findIndex(message => message.id === anchor.current!.messageId);
        const row = virtualizer.measurementsCache[index];
        if (row) {
          // 收起正文可能使锚点所在行变短, 偏移不能落到这条消息之外.
          const withinRow = Math.min(anchor.current.offsetPx, Math.max(0, row.size - paddingStart));
          offset = row.start + withinRow;
        }
      }
      if (offset !== undefined) {
        const maximum = Math.max(0, virtualizer.getTotalSize() - scroller.clientHeight);
        const destination = Math.max(0, Math.min(offset, maximum));
        if (Math.abs(scroller.scrollTop - destination) > 1) virtualizer.scrollToOffset(destination);
        if (!reachesLatest && following.current) {
          // 窗口末尾不是会话最新. 初始显示窗口末尾后改为阅读, 后续补页不自动跟随.
          following.current = false;
          rememberReadingPosition();
        }
        navigation.current = null;
        initialized.current = true;
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
      programmaticOffset.current = null;
      userScrolling.current = true;
      rememberReadingPosition();
    };
    const wheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      takeControl();
      if (event.deltaY < 0) following.current = false;
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
    scroller.addEventListener('scrollend', settleScroll);
    return () => {
      stopUserScroll();
      scroller.removeEventListener('wheel', wheel);
      scroller.removeEventListener('touchmove', takeControl);
      scroller.removeEventListener('pointerdown', pointer);
      scroller.removeEventListener('keydown', keyboard);
      scroller.removeEventListener('scrollend', settleScroll);
    };
  }, [scroller, virtualizer, paddingStart]);

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
    return !initialized.current || navigation.current !== null;
  }

  return { virtualizer, atBottom, onScroll, scrollToMessage, scrollToLatest, isPositioning };
}
