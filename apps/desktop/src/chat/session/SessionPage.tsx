import { useEffect, useLayoutEffect, useRef, useState, type JSX, type MouseEvent } from 'react';
import { Group, Panel, Separator, type PanelImperativeHandle } from 'react-resizable-panels';
import { useServerStore } from '../../stores/server.js';
import { ChatInput } from '../input/ChatInput.js';
import { MessageList } from '../history/MessageList.js';
import { SessionHeader } from './SessionHeader.js';
import { SessionSidePanel } from '../sidePanel/SessionSidePanel.js';
import { useSessionPanelStore } from '../../stores/sessionPanel.js';
import { submitChatDraft } from '../input/submitChatDraft.js';
import { SessionGitDiffProvider } from './gitDiffContext.js';
import { AttachmentDropOverlay, useAttachmentDrop } from '../input/attachmentDrop.js';

export function SessionPage({ sessionId }: { sessionId: string }): JSX.Element {
  const { dropAreaRef, overlayWidth } = useAttachmentDrop(sessionId);
  const serverStatus = useServerStore(state => state.status);
  const layout = useSessionPanelStore((state) => state.layouts[sessionId]);
  const rightPanelPercent = useSessionPanelStore((state) => state.rightPanelPercent);
  const setRightPanelPercent = useSessionPanelStore((state) => state.setRightPanelPercent);
  const openBrowserTab = useSessionPanelStore((state) => state.openBrowserTab);
  const workspacePanelRef = useRef<PanelImperativeHandle | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [bottomInset, setBottomInset] = useState<number | null>(null);
  const [latestButtonBottom, setLatestButtonBottom] = useState<number | null>(null);
  const panelOpen = layout?.open ?? false;

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    const measure = (): void => {
      const bounds = composer.getBoundingClientRect();
      const height = Math.ceil(bounds.height) + 16;
      setBottomInset(current => current === height ? current : height);
      const card = composer.querySelector<HTMLElement>('.ema-composer-card');
      if (card) {
        // 阅读留白包含项目栏和 dock padding, 按钮则贴近真正的输入卡片.
        const buttonBottom = Math.ceil(bounds.bottom - card.getBoundingClientRect().top) + 8;
        setLatestButtonBottom(current => current === buttonBottom ? current : buttonBottom);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (panelOpen) {
        workspacePanelRef.current?.resize(`${rightPanelPercent}%`);
      } else {
        workspacePanelRef.current?.collapse();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, rightPanelPercent, sessionId]);

  function openWebLink(event: MouseEvent<HTMLElement>): void {
    if (event.defaultPrevented || event.button !== 0
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (!link || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (!href) return;

    let url: URL;
    try {
      // 不加页面地址作为 base, 让本地文件和页内锚点沿用各自的打开方式.
      url = new URL(href);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    event.preventDefault();
    openBrowserTab(sessionId, url.href);
  }

  return (
    <SessionGitDiffProvider sessionId={sessionId}>
      <main
        ref={dropAreaRef}
        className="ema-chat-main relative z-10 flex min-h-0 min-w-0 flex-1 flex-col"
        onClick={openWebLink}
      >
        <SessionHeader sessionId={sessionId} />
        {serverStatus.kind === 'error' && (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-[var(--ema-danger)]/30 bg-[var(--ema-danger-muted)] px-4 py-2 text-xs text-[var(--ema-danger)]"
          >
            <span className="i-lucide:unplug" aria-hidden />
            <span className="truncate">服务器暂时离线: {serverStatus.reason}</span>
            <span className="ml-auto shrink-0 text-[var(--ema-text-tertiary)]">
              草稿会保留
            </span>
          </div>
        )}
        <Group
          orientation="horizontal"
          disableCursor
          className="ema-session-workspace-group min-h-0 min-w-0 flex-1"
          defaultLayout={!panelOpen ? { chat: 100, workspace: 0 } : { chat: 100 - rightPanelPercent, workspace: rightPanelPercent }}
          onLayoutChanged={(sizes, detail) => {
            if (detail.isUserInteraction && sizes.workspace !== undefined) {
              setRightPanelPercent(sizes.workspace);
            }
          }}
        >
          <Panel
            id="chat"
            minSize="30%"
            defaultSize={`${100 - rightPanelPercent}%`}
            className="ema-chat-content-surface relative flex min-w-0 flex-col overflow-hidden"
            data-ema-chat-column
          >
            <MessageList sessionId={sessionId} bottomInset={bottomInset} latestButtonBottom={latestButtonBottom} />
            <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
              <ChatInput onSubmit={(submitted, objective) => (submitChatDraft(sessionId, submitted, objective))} />
            </div>
          </Panel>

          <Separator disabled={!panelOpen} data-open={panelOpen} className="ema-workspace-separator" />

          <Panel
            id="workspace"
            panelRef={workspacePanelRef}
            minSize="20%"
            collapsedSize="0%"
            collapsible
            defaultSize={panelOpen ? `${rightPanelPercent}%` : '0%'}
            className="min-w-0"
          >
            <div className="ema-workspace-panel h-full min-w-0" data-open={panelOpen}>
              <SessionSidePanel sessionId={sessionId} />
            </div>
          </Panel>
        </Group>
        <AttachmentDropOverlay width={overlayWidth} />
      </main>
    </SessionGitDiffProvider>
  );
}
