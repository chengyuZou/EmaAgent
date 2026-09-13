import { useState, type JSX } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Button } from '@ema-agent/ui';
import { useServerStore } from '../../stores/server.js';
import { useSessionStore } from '../../stores/session.js';
import { ChatInput } from '../input/ChatInput.js';
import { SessionHistory } from '../history/SessionHistory.js';
import { ChatActivityStrip } from '../messages/toolBlocks/ChatActivityStrip.js';
import { SessionHeader } from './SessionHeader.js';
import { SessionSidePanel } from '../sidePanel/SessionSidePanel.js';
import {
  isSessionSidePanelFullWidth,
  useSessionSidePanel,
} from '../state/chatWorkspace.js';

export function SessionPage({ sessionId }: { sessionId: string }): JSX.Element {
  const session = useSessionStore(state => state.sessions.byId.get(sessionId));
  const serverStatus = useServerStore(state => state.status);
  const layout = useSessionSidePanel((state) => state.layouts[sessionId]);
  const fullWidth = useSessionSidePanel((state) => (
    isSessionSidePanelFullWidth(state, sessionId)
  ));
  const rightPanelPercent = useSessionSidePanel((state) => state.rightPanelPercent);
  const setRightPanelPercent = useSessionSidePanel((state) => state.setRightPanelPercent);
  const setFullWidth = useSessionSidePanel((state) => state.setFullWidth);
  const [floatingHistoryOpen, setFloatingHistoryOpen] = useState(false);

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionHeader
        sessionId={sessionId}
        title={session?.title ?? '加载中…'}
        isFork={session?.forkedFromSessionId != null}
      />
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
        key={`${sessionId}:${fullWidth}:${layout?.open ?? false}`}
        orientation="horizontal"
        className="min-h-0 min-w-0 flex-1"
        defaultLayout={fullWidth || !layout?.open ? { chat: 100 } : { chat: 100 - rightPanelPercent, workspace: rightPanelPercent }}
        onLayoutChanged={(sizes, detail) => {
          if (detail.isUserInteraction && sizes.workspace !== undefined) setRightPanelPercent(sizes.workspace);
        }}
      >
        {!fullWidth && (
          <Panel
            id="chat"
            minSize="30%"
            defaultSize={`${100 - rightPanelPercent}%`}
            className="flex min-w-0 flex-col"
          >
            <SessionHistory sessionId={sessionId} />
            <ChatActivityStrip />
            <ChatInput />
            <StatusBar sessionId={sessionId} />
          </Panel>
        )}

        {!fullWidth && layout?.open && (
          <Separator className="w-1 cursor-col-resize bg-[var(--ema-border)] hover:bg-[var(--ema-primary)]" />
        )}

        {(fullWidth || layout?.open) && (
          <Panel
            id="workspace"
            minSize={fullWidth ? '100%' : '20%'}
            defaultSize={fullWidth ? '100%' : `${rightPanelPercent}%`}
            className="min-w-0"
          >
            <SessionSidePanel
              sessionId={sessionId}
              fullWidth={fullWidth}
              {...(!fullWidth && (layout?.tabOrder.length ?? 0) > 0
                ? { onExpand: () => setFullWidth(sessionId, true) }
                : {})}
            />
          </Panel>
        )}
      </Group>

      {fullWidth && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center">
          <div className="pointer-events-auto flex w-[min(720px,92%)] flex-col gap-1.5 pb-3">
            {floatingHistoryOpen && (
              <div className="flex h-[50vh] flex-col overflow-hidden rounded-2xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] shadow-[var(--ema-shadow-3)] ema-fade-in">
                <SessionHistory sessionId={sessionId} />
              </div>
            )}
            <Button
              variant="ghost"
              className="flex size-6 items-center justify-center self-center rounded-full border border-[var(--ema-border)] bg-[var(--ema-surface-3)] p-0 shadow-[var(--ema-shadow-1)]"
              onClick={() => setFloatingHistoryOpen((value) => !value)}
              title={floatingHistoryOpen ? '合上聊天' : '展开聊天'}
            >
              <span
                className={`${floatingHistoryOpen
                  ? 'i-lucide:chevron-down'
                  : 'i-lucide:chevron-up'} text-xs`}
                aria-hidden
              />
            </Button>
            <ChatInput />
          </div>
        </div>
      )}
    </main>
  );
}

function StatusBar({ sessionId }: { sessionId: string }): JSX.Element {
  const serverStatus = useServerStore(state => state.status);
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-[var(--ema-border)] px-4 py-1.5 text-[11px] text-[var(--ema-text-tertiary)]">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 rounded-full ${serverStatus.kind === 'ok'
          ? 'bg-[var(--ema-success)]'
          : 'bg-[var(--ema-danger)]'}`}
        />
        <span>服务器</span>
        {serverStatus.kind === 'ok' && <span>{serverStatus.latencyMs}ms</span>}
      </div>
      <span className="font-mono opacity-40">{sessionId.slice(0, 8)}</span>
    </div>
  );
}
