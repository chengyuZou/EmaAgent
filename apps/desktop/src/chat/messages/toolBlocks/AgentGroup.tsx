// 单独展示 Subagent Tool 创建的 Subagent;前台 Tool 与后台 Subagent 只暴露各自正确的停止入口.

import { memo, useEffect, useState, type JSX } from 'react';
import { subagentsApi, type SubagentRunItem } from '../../../api/subagents.js';
import { useMessageExpansion } from '../messageExpansion.js';
import { IconButton } from '@ema-agent/ui';
import { useShallow } from 'zustand/react/shallow';
import { sessionWebSocket } from '../../../api/sessionWebSocket.js';
import { useSubagentStore } from '../../../stores/subagent.js';
import { useSessionPanelStore } from '../../../stores/sessionPanel.js';
import { renderToolResult } from './tool-renderers.js';
import { formatJson } from './toolBlockHelpers.js';
import { ToolFailure, ToolPane } from './ToolCallBlock.js';
import { ToolArgsView, ToolResultViewBlock } from './ToolRenderBlocks.js';
import { lookupToolUI } from './toolUIRegistry.js';
import {
  toolArgs,
  toolCallId,
  toolFallbackContent,
  toolFailure,
  toolName,
  toolOutput,
  toolRunning,
  type ToolDisplayCall,
} from './toolGroups.js';

interface AgentState {
  readonly subagentId?: string;
  readonly runId?: string;
  readonly running: boolean;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly description?: string;
}

export const AgentGroup = memo(function AgentGroup({
  calls,
  streaming,
  turnId,
  sessionId,
  sectionKey,
}: {
  readonly calls: readonly ToolDisplayCall[];
  readonly streaming: boolean;
  readonly turnId?: string;
  readonly sessionId: string;
  readonly sectionKey: string;
}): JSX.Element {
  const [open, setOpen] = useMessageExpansion(sectionKey);
  const liveReferences = useSubagentStore(useShallow(state => (
    calls.map(call => state.toolReferences.get(toolCallId(call)))
  )));
  const references = calls.map((call, index) => resultReference(call) ?? liveReferences[index]);
  const subagentProgress = useSubagentStore(useShallow(state => (
    references.map(ref => ref ? state.progressById.get(ref.subagentId) : undefined)
  )));
  const storedSubagents = useSubagentStore(useShallow(state => (
    references.map(ref => ref ? state.subagents.get(ref.subagentId) : undefined)
  )));
  const liveRuns = useSubagentStore(useShallow(state => (
    references.map(ref => ref ? state.runsById.get(ref.runId) : undefined)
  )));
  const states = calls.map((call, index): AgentState => {
    const progress = subagentProgress[index];
    const record = storedSubagents[index];
    const reference = references[index];
    const running = progress !== undefined && progress.runId === reference?.runId;
    let status: AgentState['status'] = liveRuns[index]?.status ?? 'unknown';
    if (running || toolRunning(call, streaming)) {
      status = 'running';
    } else if (toolFailure(call)) {
      status = 'failed';
    }
    return {
      ...reference,
      running,
      status,
      description: record?.title ?? undefined,
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
  const [detailsOpen, setDetailsOpen] = useMessageExpansion(`agent:${toolCallId(call)}`);
  const openTab = useSessionPanelStore(state => state.openTab);
  const toolCallIdValue = toolCallId(call);
  const subagentId = state.subagentId;
  const runId = state.runId;
  const liveRun = useSubagentStore(value => runId ? value.runsById.get(runId) : undefined);
  const [run, setRun] = useState<SubagentRunItem | null>(null);
  useEffect(() => {
    if (!subagentId || !runId) {
      return;
    }
    const controller = new AbortController();
    setRun(null);
    void subagentsApi.getRun(subagentId, runId, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        setRun(value);
      }
    }).catch(() => { });
    return () => controller.abort();
  }, [subagentId, runId]);
  const runStatus = liveRun?.status ?? run?.status;
  const args = toolArgs(call);
  const output = toolOutput(call);
  const renderedOutput = output ?? toolFallbackContent(call);
  const toolUI = lookupToolUI(toolName(call));
  const customResult = output != null ? toolUI?.ResultView?.({ data: output, args }) : null;
  const genericResult = renderedOutput != null ? renderToolResult(renderedOutput) : null;
  const resultCopyText = renderedOutput != null
    ? toolUI?.resultCopyText?.(output, args) ?? formatJson(renderedOutput)
    : '';
  const toolStillRunning = toolRunning(call, streaming);
  const cancelTarget = agentCancelTarget(call, streaming, state.running);
  const failure = toolFailure(call);
  let status = '读取中';
  if (toolStillRunning || state.running) {
    status = '运行中';
  } else if (failure || runStatus === 'failed') {
    status = '失败';
  } else if (runStatus === 'cancelled') {
    status = '已停止';
  } else if (runStatus === 'completed') {
    status = '已完成';
  }

  const failureText = failure ? `[${failure.code}] ${failure.message}` : '';
  const hasDetails = args !== undefined || renderedOutput !== undefined || failure !== null;

  return (
    <div className="ema-tool-card min-w-0 text-xs text-[var(--ema-text-secondary)]">
      <div className="ema-tool-card-header">
        <button
          type="button"
          className="ema-tool-row group min-w-0 flex-1"
          onClick={() => setDetailsOpen(value => !value)}
          aria-expanded={detailsOpen}
          disabled={!hasDetails}
        >
          <span className="ema-tool-row-leading" aria-hidden>
            <span className="i-lucide:bot ema-tool-row-icon" />
            <span className="i-lucide:chevron-down ema-tool-row-chevron" />
          </span>
          <span className="ema-tool-row-summary">{state.description ?? subagentId ?? toolCallIdValue}</span>
          <span className="shrink-0 text-[10px] text-[var(--ema-text-tertiary)]">{status}</span>
        </button>
        {subagentId && (
          <IconButton
            label="打开子代理面板"
            icon="i-lucide:panel-right-open"
            variant="ghost"
            size="sm"
            shape="rounded"
            className="ema-tool-card-icon"
            onClick={() => openTab(sessionId, { id: 'subagents', kind: 'subagents', subagentId })}
          />
        )}
        {cancelTarget === 'tool' && turnId && (
          <IconButton
            label="中止子代理工具"
            icon="i-lucide:circle-stop"
            variant="danger"
            size="sm"
            shape="rounded"
            className="ema-tool-card-icon"
            onClick={() => void sessionWebSocket.cancelTool(sessionId, turnId, toolCallIdValue)}
          />
        )}
        {cancelTarget === 'subagent' && subagentId && (
          <IconButton
            label="中止后台子代理"
            icon="i-lucide:circle-stop"
            variant="danger"
            size="sm"
            shape="rounded"
            className="ema-tool-card-icon"
            onClick={() => void sessionWebSocket.cancelSubagent(sessionId, subagentId)}
          />
        )}
      </div>
      {detailsOpen && (
        <div className="ema-tool-card-body">
          <div className="ema-tool-frame">
            {args !== undefined && (
              <ToolPane label="复制输入" tone="input" copyText={formatJson(args)}>
                <ToolArgsView args={args} />
              </ToolPane>
            )}
            {(renderedOutput !== undefined || failure) && (
              <ToolPane
                label="复制输出"
                tone="output"
                copyText={[resultCopyText, failureText].filter(Boolean).join('\n\n')}
                errorOnly={failure !== null && renderedOutput === undefined}
              >
                {customResult ?? (genericResult !== null && <ToolResultViewBlock view={genericResult} />)}
                {failure && <ToolFailure code={failure.code} message={failure.message} />}
              </ToolPane>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function resultReference(call: ToolDisplayCall): { subagentId: string; runId: string } | undefined {
  const output = toolOutput(call);
  if (typeof output !== 'object' || output === null || !('subagentId' in output)
    || !('runId' in output)) {
    return undefined;
  }
  if (typeof output.subagentId !== 'string' || typeof output.runId !== 'string') {
    return undefined;
  }
  return { subagentId: output.subagentId, runId: output.runId };
}

/** 前台 Tool 仍在执行时取消 Tool；转入后台后用独立的 SubagentId 取消子代理. */
export function agentCancelTarget(call: ToolDisplayCall, streaming: boolean, subagentRunning: boolean): 'tool' | 'subagent' | null {
  if (toolRunning(call, streaming)) {
    return 'tool';
  }
  return subagentRunning ? 'subagent' : null;
}
