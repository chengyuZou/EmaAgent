// 单独展示 Subagent Tool 创建的 Subagent;前台 Tool 与后台 Subagent 只暴露各自正确的停止入口.

import { memo, useState, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { useShallow } from 'zustand/react/shallow';
import { sessionWebSocket } from '../../../api/sessionWebSocket.js';
import { useSubagentStore } from '../../../stores/subagent.js';
import { useSessionPanelStore } from '../../../stores/sessionPanel.js';
import {
  toolCallId,
  toolFailure,
  toolOutput,
  toolRunning,
  type ToolDisplayCall,
} from './toolGroups.js';

interface AgentState {
  readonly subagentId?: string;
  readonly running: boolean;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly description?: string;
}

export const AgentGroup = memo(function AgentGroup({
  calls,
  streaming,
  turnId,
  sessionId,
}: {
  readonly calls: readonly ToolDisplayCall[];
  readonly streaming: boolean;
  readonly turnId?: string;
  readonly sessionId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const subagentIds = useSubagentStore(useShallow(state => (
    calls.map(call => state.invocationsBySession.get(sessionId)?.get(toolCallId(call)) ?? resultSubagentId(call))
  )));
  const subagentProgress = useSubagentStore(useShallow(state => (
    subagentIds.map(id => id ? state.progressById.get(id) : undefined)
  )));
  const storedSubagents = useSubagentStore(useShallow(state => (
    subagentIds.map(id => id ? state.subagents.get(id) : undefined)
  )));
  const states = calls.map((_call, index): AgentState => {
    const progress = subagentProgress[index];
    const record = storedSubagents[index];
    return {
      ...(subagentIds[index] ? { subagentId: subagentIds[index] } : {}),
      running: progress !== undefined,
      status: progress ? 'running' : record?.status ?? 'unknown',
      description: record?.description ?? progress?.description,
    };
  });
  const running = states.filter(state => state.running).length;
  const failed = states.filter(state => state.status === 'failed' || state.status === 'cancelled').length;

  if (calls.length === 1 && calls[0] && states[0]) {
    return (
      <AgentRow
        call={calls[0]}
        state={states[0]}
        streaming={streaming}
        turnId={turnId}
        sessionId={sessionId}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex items-center gap-1.5 py-0.5 text-left text-xs text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)]"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="i-lucide:bot" aria-hidden />
        <span>{calls.length} 个子代理 · {running} 运行中 · {calls.length - running} 已结束</span>
        {failed > 0 && <span className="text-[var(--ema-danger-text)]">· {failed} 异常</span>}
        <span
          className="i-lucide:chevron-down ml-auto text-[10px] transition-transform duration-[var(--ema-duration-fast)]"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
          aria-hidden
        />
      </button>
      <div
        className="ema-collapsible ema-chat-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="flex flex-col gap-0.5 pt-0.5">
          {open && calls.map((call, index) => (
            <AgentRow
              key={toolCallId(call)}
              call={call}
              state={states[index]!}
              streaming={streaming}
              turnId={turnId}
              sessionId={sessionId}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

function AgentRow({
  call,
  state,
  streaming,
  turnId,
  sessionId,
}: {
  readonly call: ToolDisplayCall;
  readonly state: AgentState;
  readonly streaming: boolean;
  readonly turnId?: string;
  readonly sessionId: string;
}): JSX.Element {
  const openTab = useSessionPanelStore(state => state.openTab);
  const toolCallIdValue = toolCallId(call);
  const subagentId = state.subagentId;
  const toolStillRunning = toolRunning(call, streaming);
  const cancelTarget = agentCancelTarget(call, streaming, state.running);
  const failure = toolFailure(call);
  const status = toolStillRunning || state.running
    ? '运行中'
    : failure || state.status === 'failed'
      ? '失败'
      : state.status === 'cancelled'
        ? '已停止'
        : '已完成';

  return (
    <div className="flex items-center gap-2 py-1 text-xs text-[var(--ema-text-secondary)]">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-[var(--ema-text-primary)]"
        onClick={() => {
          if (subagentId) openTab(sessionId, { id: 'subagents', kind: 'subagents', subagentId });
        }}
        disabled={!subagentId}
      >
        <span className="i-lucide:bot shrink-0" aria-hidden />
        <span className="truncate">{state.description ?? subagentId ?? toolCallIdValue}</span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--ema-text-tertiary)]">{status}</span>
      </button>
      {cancelTarget === 'tool' && turnId && (
        <IconButton
          label="中止子代理工具"
          icon="i-lucide:circle-stop"
          variant="danger"
          size="sm"
          onClick={() => void sessionWebSocket.cancelTool(sessionId, turnId, toolCallIdValue)}
        />
      )}
      {cancelTarget === 'subagent' && subagentId && (
        <IconButton
          label="中止后台子代理"
          icon="i-lucide:circle-stop"
          variant="danger"
          size="sm"
          onClick={() => void sessionWebSocket.cancelSubagent(sessionId, subagentId)}
        />
      )}
    </div>
  );
}

function resultSubagentId(call: ToolDisplayCall): string | undefined {
  const output = toolOutput(call);
  if (typeof output !== 'object' || output === null || !('subagentId' in output)) return undefined;
  return typeof output.subagentId === 'string' ? output.subagentId : undefined;
}

/** 前台 Tool 仍在执行时取消 Tool；转入后台后用独立的 SubagentId 取消子代理. */
export function agentCancelTarget(
  call: ToolDisplayCall,
  streaming: boolean,
  subagentRunning: boolean,
): 'tool' | 'subagent' | null {
  if (toolRunning(call, streaming)) return 'tool';
  return subagentRunning ? 'subagent' : null;
}
