import { useEffect, useRef, type JSX } from 'react';
import {
  Group,
  Panel,
  Separator,
  type PanelImperativeHandle,
} from 'react-resizable-panels';
import { useServerStore } from '../../stores/server.js';
import { ChatInput } from '../input/ChatInput.js';
import { SessionHistory } from '../history/SessionHistory.js';
import { ChatActivityStrip } from '../messages/toolBlocks/ChatActivityStrip.js';
import { SessionHeader } from './SessionHeader.js';
import { SessionSidePanel } from '../sidePanel/SessionSidePanel.js';
import { useSessionSidePanel } from '../state/chatWorkspace.js';

export function SessionPage({ sessionId }: { sessionId: string }): JSX.Element {
  const serverStatus = useServerStore(state => state.status);
  const layout = useSessionSidePanel((state) => state.layouts[sessionId]);
  const rightPanelPercent = useSessionSidePanel((state) => state.rightPanelPercent);
  const setRightPanelPercent = useSessionSidePanel((state) => state.setRightPanelPercent);
  const workspacePanelRef = useRef<PanelImperativeHandle | null>(null);
  const panelOpen = layout?.open ?? false;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (panelOpen) workspacePanelRef.current?.resize(`${rightPanelPercent}%`);
      else workspacePanelRef.current?.collapse();
    });
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, rightPanelPercent, sessionId]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        className="ema-session-workspace-group min-h-0 min-w-0 flex-1"
        defaultLayout={!panelOpen ? { chat: 100, workspace: 0 } : { chat: 100 - rightPanelPercent, workspace: rightPanelPercent }}
        onLayoutChanged={(sizes, detail) => {
          if (detail.isUserInteraction && sizes.workspace !== undefined) setRightPanelPercent(sizes.workspace);
        }}
      >
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

        <Separator
          disabled={!panelOpen}
          data-open={panelOpen}
          className="ema-workspace-separator"
        />

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
