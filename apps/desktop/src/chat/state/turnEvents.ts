// 把 Turn 的结构化 SSE 事件路由到各业务 Store。
// 线上形状 = TurnSseEvent（server eventHub 唯一事实源）；本文件只做路由，
// 状态变更一律调用 store 的公开 action，不做体外手术。
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { presentConfiguredEvent } from '../../lib/event-notifications.js';
import {
  handleTtsChunk,
  handleTtsSentenceComplete,
  handleTurnCompleted,
  handleTurnAborted,
} from '../../lib/tts-playback.js';
import { useDecisionStore } from '../../stores/decision.js';
import {
  useAgentRunStore,
  type LiveAgentRunInfo,
} from '../../stores/agentRun.js';
import { useTaskStore } from '../../stores/task.js';
import { useContextUsage } from './contextUsage.js';
import { useTurnUsage } from './turnUsage.js';
import { useMessages } from './messages.js';
import { useCurrentSession } from './currentSession.js';

import type { TurnSseEvent } from '@ema-agent/server/sse/eventHub.js';

// ── 模块级助手 ────────────────────────────────────────────────────────────────

/** 合并一次 AgentRun 进度事件进 live 投影；持久字段仍以 HTTP 响应为准。 */
function patchLiveAgentRun(agentRunId: string, patch: Partial<LiveAgentRunInfo>): void {
  const store = useAgentRunStore.getState();
  const existing = store.runs.get(agentRunId);
  const base: LiveAgentRunInfo = existing?.live ?? {
    startedAtMs: Date.now(), promptExcerpt: '', model: '',
    iteration: 0, toolCallCount: 0, elapsedMs: 0,
  };
  store.upsert({ id: agentRunId, live: { ...base, ...patch } });
}

/** Turn 终态后持久 Task 已过期；Task 没有独立事件，终态是唯一的刷新节拍。 */
function refreshTasksAfterTerminal(sessionId: string): void {
  void useTaskStore.getState().loadForSession(sessionId, true).catch(() => {});
}

// ── 主路由 ────────────────────────────────────────────────────────────────────

export function dispatchTurnEvent(event: TurnSseEvent, sessionId: string): void {
  presentConfiguredEvent(event);
  const messages = useMessages.getState();
  const currentSession = useCurrentSession.getState();

  switch (event.type) {

    // ── Turn 生命周期 ─────────────────────────────────────────────────────

    case 'turn_started': {
      messages.beginStream(
        sessionId,
        event.turnId,
        event.executionProfile,
        event.narrativePolicy,
      );
      currentSession.claimStageOwner(sessionId);
      void tauriBridge.emit('speech:start', { sessionId });
      break;
    }

    case 'turn_completed':
      handleTurnCompleted(sessionId);
      useTurnUsage.getState().clearTurn(event.turnId);
      messages.settleStream(sessionId);
      refreshTasksAfterTerminal(sessionId);
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    case 'turn_failed':
      handleTurnAborted(sessionId);
      useTurnUsage.getState().clearTurn(event.turnId);
      messages.abortStream(sessionId, event.message);
      refreshTasksAfterTerminal(sessionId);
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    case 'turn_aborted':
      handleTurnAborted(sessionId);
      useTurnUsage.getState().clearTurn(event.turnId);
      messages.abortStream(sessionId, event.reason);
      refreshTasksAfterTerminal(sessionId);
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    // ── Usage ─────────────────────────────────────────────────────────────

    case 'context_usage_updated':
      useContextUsage.getState().applyLlmCall(sessionId, event.llmCallId, event.usage);
      break;

    case 'agent_usage_updated':
      // 事件携带该 AgentLoop 截至当前的累计值，替换不叠加。
      useTurnUsage.getState().setRootUsage(event.turnId, event.usage);
      break;

    // ── 内容流 ────────────────────────────────────────────────────────────

    case 'output_text_delta':
      messages.appendTextDelta(sessionId, event.delta);
      void tauriBridge.emit('speech:delta', { sessionId, text: event.delta });
      break;

    case 'reasoning_delta':
      messages.appendThinkingDelta(sessionId, event.delta);
      break;

    case 'reasoning_complete':
      messages.markThinkingDone(sessionId, event.blockIndex);
      break;

    // ── 工具事件 ──────────────────────────────────────────────────────────

    case 'tool_call_partial':
      messages.upsertPartialToolCall(sessionId, event.callId, event.name, event.argsDelta);
      break;

    case 'tool_call_complete':
      messages.completeToolCall(sessionId, event.callId, event.name, event.args);
      break;

    case 'tool_result':
      messages.setToolResult(sessionId, event.callId, {
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.error ? { error: event.error } : {}),
        durationMs: event.durationMs,
      });
      break;

    // ── 决策事件：decision store 入队 + 中继给桌宠窗 ──────────────────────────

    case 'ask_user_required': {
      // createdAt 仅补齐快照形状；实时条目的 FIFO 顺序即到达顺序，前端不再读取该值。
      useDecisionStore.getState().push({ kind: 'askUser', createdAt: Date.now(), request: event });
      void tauriBridge.emit('decision:push', event);
      break;
    }
    case 'ask_user_resolved':
      useDecisionStore.getState().dismiss(event.toolCallId);
      void tauriBridge.emit('decision:dismiss', { toolCallId: event.toolCallId });
      break;

    case 'permission_required': {
      const { type: _type, ...request } = event;
      useDecisionStore.getState().push({
        kind: 'permission',
        toolCallId: event.toolCallId,
        // createdAt 仅补齐快照形状；实时条目的 FIFO 顺序即到达顺序，前端不再读取该值。
        createdAt: Date.now(),
        request,
      });
      void tauriBridge.emit('decision:push', event);
      // toolCallId 精确关联：同名工具允许在一个 Turn 内并发。
      messages.setToolPermissionPending(sessionId, event.toolCallId, true);
      break;
    }
    case 'permission_resolved':
      useDecisionStore.getState().dismiss(event.toolCallId);
      void tauriBridge.emit('decision:dismiss', { toolCallId: event.toolCallId });
      // allow → 清等待标记恢复运行中；deny → 等后端 tool_result(permission/denied) 统一收口
      if (event.decision === 'allow') {
        messages.setToolPermissionPending(sessionId, event.toolCallId, false);
      }
      break;

    // ── TTS ───────────────────────────────────────────────────────────────

    case 'tts_chunk':
      handleTtsChunk(event);
      break;

    case 'tts_sentence_complete':
      handleTtsSentenceComplete(event);
      break;

    case 'tts_warning':
      // 提示条由 presentConfiguredEvent 统一展示；播放链不中断。
      break;

    // ── 情绪 / 舞台 ───────────────────────────────────────────────────────

    case 'emotion_changed':
      currentSession.setEmotion(sessionId, event.emotion);
      break;

    case 'motion_changed':
      if (sessionId === currentSession.ttsOwnerSessionId) {
        void tauriBridge.emit('stage:motion-changed', { motion: event.motion });
      }
      break;

    // ── Agent 事件 ────────────────────────────────────────────────────────

    case 'agent_iteration':
      messages.setIteration(sessionId, event.n);
      break;

    // ── 子 Agent 生命周期 ─────────────────────────────────────────────────

    case 'agent_run_started':
      useAgentRunStore.getState().upsert({
        id: event.agentRunId,
        sessionId: event.sessionId as string,
        parentTurnId: event.turnId as string,
        contextMode: event.contextMode,
        ...(event.description !== undefined ? { description: event.description } : {}),
        ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
        status: 'running',
        version: 0,
        createdAt: event.startedAt, updatedAt: event.startedAt,
        live: {
          startedAtMs: event.startedAt, promptExcerpt: event.description ?? '',
          model: event.modelId ?? '', iteration: 0, toolCallCount: 0, elapsedMs: 0,
        },
      });
      // 先建立空记录，让详情面板无需等待持久结果即可展示流式内容。
      useAgentRunStore.setState((s) => {
        if (s.transcripts.has(event.agentRunId)) return {};
        const transcripts = new Map(s.transcripts);
        transcripts.set(event.agentRunId, []);
        return { transcripts };
      });
      break;

    case 'agent_run_event': {
      const runId = event.agentRunId;
      const inner = event.event;
      const agentRunStore = useAgentRunStore.getState();

      if (inner.type === 'agent_usage_updated') {
        // 子 Agent 的累计值按 agentRunId 替换，不叠加；只进 Turn 消耗展示，不进 Context 球。
        useTurnUsage.getState().setSubagentUsage(event.turnId, runId, inner.usage);
      } else if (inner.type === 'iteration_started') {
        patchLiveAgentRun(runId, { iteration: inner.iteration });
      } else if (inner.type === 'text_delta') {
        agentRunStore.appendLiveTranscript(runId, 'assistant', { blockIndex: inner.blockIndex, text: inner.delta });
      } else if (inner.type === 'thinking_delta') {
        agentRunStore.appendLiveTranscript(runId, 'reasoning', { blockIndex: inner.blockIndex, text: inner.delta });
      } else if (inner.type === 'tool_use_completed') {
        agentRunStore.appendLiveTranscript(runId, 'tool_call', {
          blockIndex: inner.blockIndex,
          callId: inner.toolCallId,
          name: inner.toolName,
          args: inner.args,
        });
        const current = agentRunStore.runs.get(runId)?.live?.toolCallCount ?? 0;
        patchLiveAgentRun(runId, { toolCallCount: current + 1 });
      } else if (inner.type === 'tool_result') {
        // content 即统一 ToolResult 信封，原样透传不拆字段。
        agentRunStore.appendLiveTranscript(runId, 'tool_result', inner.result);
      }
      break;
    }

    case 'agent_run_completed':
      useAgentRunStore.getState().upsert({
        id: event.agentRunId, status: 'completed', updatedAt: Date.now(),
        iterations: event.state.iterations,
        inputTokens: event.state.usage.inputTokens,
        outputTokens: event.state.usage.outputTokens,
        outputExcerpt: event.finalText.slice(0, 500),
        completedAt: Date.now(),
        live: undefined,
      });
      break;

    case 'agent_run_failed':
      useAgentRunStore.getState().upsert({
        id: event.agentRunId, status: 'failed', error: event.error,
        updatedAt: Date.now(), completedAt: Date.now(), live: undefined,
      });
      break;

    case 'agent_run_aborted':
      useAgentRunStore.getState().upsert({
        id: event.agentRunId, status: 'cancelled', error: event.reason,
        updatedAt: Date.now(), completedAt: Date.now(), live: undefined,
      });
      break;

    // ── Narrative ─────────────────────────────────────────────────────────

    case 'narrative_recall_started':
      messages.narrativeRecallStarted(sessionId);
      break;

    case 'narrative_recall_completed':
      messages.narrativeRecallCompleted(sessionId, event);
      break;

    case 'narrative_recall_failed':
      messages.narrativeRecallFailed(sessionId, event.message);
      break;

    // ── Compact ───────────────────────────────────────────────────────────

    case 'compact_started':
    case 'compact_history_truncated':
    case 'compact_cancelled':
    case 'compact_failed':
      break;

    case 'compact_completed':
      // 摘要消息由后端落库（kind='summary'），重拉历史即现；不合成前端通知行。
      void messages.reloadMessages(sessionId);
      break;

    // ── 其余 ──────────────────────────────────────────────────────────────

    case 'request_degraded':
      // 自动降级不打断用户，但必须保留可诊断的结构化记录。
      console.info('[turn-events] request_degraded:', {
        sessionId: event.sessionId,
        turnId: event.turnId,
        attempt: event.attempt,
        reason: event.reason,
        removed: event.removed,
        replacements: event.replacements,
      });
      break;

    case 'turn_projection_warning':
      console.warn('[turn-events] turn_projection_warning:', {
        sessionId: event.sessionId,
        turnId: event.turnId,
        projection: event.projection,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      });
      break;

    default:
      break;
  }
}
