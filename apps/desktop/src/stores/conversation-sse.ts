// 把 Turn 的结构化 SSE 事件分发给会话状态和各业务 Store。
// 线上形状 = TurnStreamEvent（turn/agent/tools/permission/compact/narrative/stage
// 各域组合）+ SpeechEvent（语音合流事件共享同一游标序列）。
import {
  tauriBridge }             from '../lib/tauri-bridge.js';
import { presentConfiguredEvent } from '../lib/event-notifications.js';
import {
  handleTtsChunk,
  handleTtsSentenceComplete,
  handleTurnCompleted,
  handleTurnAborted,
  } from '../lib/tts-playback.js';
import { useDecisionStore }        from './decision-store.js';
import {
  useAgentRunStore,
  type AgentRunMessageItem,
  type LiveAgentRunInfo,
} from './agentRunStore.js';
import { useTaskStore }            from './taskStore.js';
import { useConversationStore }    from './conversation-store.js';

import type {
  ExecutionProfile,
  NarrativePolicy,
} from '@ema-agent/session';
import type {
  TurnStats,
} from '@ema-agent/turn';
import type { TurnSseEvent } from '@ema-agent/server/sse/eventHub.js';

/** Turn SSE 线上事件：Turn 流 + 语音输出事件（server eventHub 唯一事实源）。 */

// ── StreamCallbacks ───────────────────────────────────────────────────────────

export type DeltaSlice = 'text' | 'thinking' | 'tool_use' | 'tool_result';
export type DeltaPayload =
  | string
  | { callId: string; name: string; args: unknown }
  | { callId: string; output?: unknown; error?: { code: string; message: string }; durationMs?: number };

export interface StreamCallbacks {
  beginStream(
    sessionId: string,
    turnId: string,
    executionProfile: ExecutionProfile,
    narrativePolicy: NarrativePolicy,
  ): void;
  appendDelta(sessionId: string, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: string, stats: TurnStats | null): void;
  abortStream(sessionId: string, reason: string): void;
}

// ── Module-level temp state ───────────────────────────────────────────────────

/** 合并一次 AgentRun 进度事件进 live 投影；持久字段仍以 HTTP 快照为准。 */
function patchLiveAgentRun(agentRunId: string, patch: Partial<LiveAgentRunInfo>): void {
  const store = useAgentRunStore.getState();
  const existing = store.runs.get(agentRunId);
  const base: LiveAgentRunInfo = existing?.live ?? {
    startedAtMs: Date.now(), promptExcerpt: '', model: '',
    iteration: 0, toolCallCount: 0, elapsedMs: 0,
  };
  store.upsert({ id: agentRunId, live: { ...base, ...patch } });
}

/** Turn 终态后持久 Task 快照已过期；Task 没有独立事件，终态是唯一的刷新节拍。 */
function refreshTasksAfterTerminal(sessionId: string): void {
  void useTaskStore.getState().loadForSession(sessionId, true).catch(() => {});
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export function dispatchSseEvent(
  event:     TurnSseEvent,
  sessionId: string,
  cb:        StreamCallbacks,
): void {
  presentConfiguredEvent(event);
  switch (event.type) {

    // ── Turn lifecycle ─────────────────────────────────────────────────────

    case 'turn_started': {
      cb.beginStream(
        sessionId,
        event.turnId,
        event.executionProfile,
        event.narrativePolicy,
      );
      useConversationStore.setState((s) => {
        const u = new Map(s.liveUsageMap);    u.delete(event.turnId as string);
        const t = new Map(s.thinkingActiveMap); t.delete(event.turnId as string);
        // 给最后一条 user message 补 turnId(乐观更新时没带,且 loadMessages 对已有
        // session 不刷新 -> user message 永远没 turnId -> ForkButton 不显示)
        const msgs = new Map(s.messages);
        const list = msgs.get(sessionId as string);
        if (list && list.length > 0) {
          const last = list[list.length - 1];
          if (last && last.role === 'user' && !last.turnId) {
            const updated = list.slice();
            updated[updated.length - 1] = { ...last, turnId: event.turnId };
            msgs.set(sessionId as string, updated);
          }
        }
        return { liveUsageMap: u, thinkingActiveMap: t, messages: msgs };
      });
      const prev = useConversationStore.getState().ttsOwnerSessionId;
      if ((prev as string) !== (sessionId as string)) {
        useConversationStore.setState({ ttsOwnerSessionId: sessionId });
        const saved = useConversationStore.getState().emotionStateMap.get(sessionId as string);
        if (saved) void tauriBridge.emit('stage:emotion-changed', saved);
      }
      void tauriBridge.emit('speech:start', { sessionId });
      break;
    }

    case 'turn_completed':
      handleTurnCompleted(sessionId as string);
      cb.finalizeStream(sessionId, event.stats);
      refreshTasksAfterTerminal(sessionId as string);
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    case 'turn_failed':
      handleTurnAborted(sessionId as string);
      cb.abortStream(sessionId, event.message);
      refreshTasksAfterTerminal(sessionId as string);
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    case 'turn_aborted': {
      handleTurnAborted(sessionId as string);
      cb.abortStream(sessionId, event.reason);
      refreshTasksAfterTerminal(sessionId as string);
      void tauriBridge.emit('speech:end', { sessionId });
      break;
    }

    // ── Content streaming ─────────────────────────────────────────────────

    case 'usage_update':
      useConversationStore.setState((s) => {
        const m = new Map(s.liveUsageMap);
        m.set(event.turnId as string, { inputTokens: event.inputTokens, outputTokens: event.outputTokens });
        return { liveUsageMap: m };
      });
      break;

    case 'output_text_delta':
      cb.appendDelta(sessionId, 'text', event.delta);
      void tauriBridge.emit('speech:delta', { sessionId, text: event.delta });
      break;

    case 'reasoning_delta':
      cb.appendDelta(sessionId, 'thinking', event.delta);
      useConversationStore.setState((s) => {
        const turnId = s.streamingMap.get(sessionId as string)?.turnId;
        if (!turnId) return {};
        const t = new Map(s.thinkingActiveMap);
        t.set(turnId as string, true);
        return { thinkingActiveMap: t };
      });
      break;

    case 'reasoning_complete':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        let thinkingIdx = 0;
        const slices = sm.slices.map((sl) => {
          if (sl.type !== 'thinking') return sl;
          const hit = thinkingIdx === event.blockIndex;
          thinkingIdx++;
          return hit ? { ...sl, done: true } : sl;
        });
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        const t = new Map(s.thinkingActiveMap);
        t.delete(sm.turnId as string);
        return { streamingMap: streaming, thinkingActiveMap: t };
      });
      break;

    // ── Tool events ────────────────────────────────────────────────────────

    case 'tool_call_partial':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const idx = sm.slices.findIndex((sl) => sl.type === 'tool_use' && sl.callId === event.callId);
        const slices = idx >= 0
          ? sm.slices.map((sl, i) => {
              if (i !== idx) return sl;
              const tsl = sl as Extract<typeof sl, { type: 'tool_use' }>;
              return { ...tsl, partialArgs: (tsl.partialArgs ?? '') + event.argsDelta };
            })
          : [...sm.slices, { type: 'tool_use' as const, callId: event.callId, name: event.name, partialArgs: event.argsDelta }];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    case 'tool_call_complete':
      cb.appendDelta(sessionId, 'tool_use', { callId: event.callId, name: event.name, args: event.args });
      break;

    case 'tool_result':
      cb.appendDelta(sessionId, 'tool_result', {
        callId: event.callId,
        output: event.output,
        error: event.error,
        durationMs: event.durationMs,
      });
      break;

    // ── Decision events — push to decision-store + relay to pet window ────

    case 'ask_user_required': {
      const { type: _type, ...request } = event;
      const p = { kind: 'ask_user' as const, ...request };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      break;
    }
    case 'ask_user_resolved':
      useDecisionStore.getState().dismiss(event.toolCallId);
      void tauriBridge.emit('decision:dismiss', { toolCallId: event.toolCallId });
      break;

    case 'permission_required': {
      const { type: _type, ...request } = event;
      const p = { kind: 'permission' as const, ...request };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      // toolCallId 精确关联：同名工具允许在一个 Turn 内并发。
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        let set = false;
        const slices = sm.slices.map((sl) => {
          if (set) return sl;
          if (sl.type === 'tool_use' && sl.callId === event.toolCallId) {
            set = true;
            return { ...sl, permissionPending: true };
          }
          return sl;
        });
        if (!set) return {};
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;
    }
    case 'permission_resolved':
      useDecisionStore.getState().dismiss(event.toolCallId);
      void tauriBridge.emit('decision:dismiss', { toolCallId: event.toolCallId });
      // allow → 清掉 permissionPending 恢复运行中；deny → 不在此标失败，等后端 tool_result(permission/denied) 统一处理
      if (event.decision === 'allow') {
        useConversationStore.setState((s) => {
          const sm = s.streamingMap.get(sessionId as string);
          if (!sm) return {};
          const slices = sm.slices.map((sl) =>
            sl.type === 'tool_use' && sl.callId === event.toolCallId
              ? { ...sl, permissionPending: undefined }
              : sl,
          );
          const streaming = new Map(s.streamingMap);
          streaming.set(sessionId as string, { ...sm, slices });
          return { streamingMap: streaming };
        });
      }
      break;

    // ── TTS ────────────────────────────────────────────────────────────────

    case 'tts_chunk':
      handleTtsChunk(event);
      break;

    case 'tts_sentence_complete':
      handleTtsSentenceComplete(event);
      break;

    case 'tts_warning':
      // 提示条由 presentConfiguredEvent 统一展示；播放链不中断。
      break;

    // ── Emotion / stage ────────────────────────────────────────────────────

    case 'emotion_changed': {
      useConversationStore.setState((s) => {
        const m = new Map(s.emotionStateMap);
        m.set(event.sessionId as string, event.state);
        return { emotionStateMap: m };
      });
      if ((event.sessionId as string) === (useConversationStore.getState().ttsOwnerSessionId as string)) {
        void tauriBridge.emit('stage:emotion-changed', event.state);
      }
      break;
    }

    case 'stage_cue':
      if ((event.sessionId as string) === (useConversationStore.getState().ttsOwnerSessionId as string)) {
        void tauriBridge.emit('stage:cue', event.cue);
      }
      break;

    // ── Agent events ───────────────────────────────────────────────────────

    case 'agent_iteration':
      useConversationStore.setState((s) => {
        const m = new Map(s.iterationCountMap);
        m.set(sessionId as string, event.n);
        return { iterationCountMap: m };
      });
      break;

    // ── Subagent lifecycle ─────────────────────────────────────────────────

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
      // 先建立空记录，让详情面板无需等待持久快照即可展示流式内容。
      useAgentRunStore.setState((s) => {
        if (s.transcripts.has(event.agentRunId)) return {};
        const trans = new Map(s.transcripts);
        trans.set(event.agentRunId, []);
        return { transcripts: trans };
      });
      break;

    case 'agent_run_event': {
      const runId = event.agentRunId;
      const inner = event.event;
      const agentRunStore = useAgentRunStore.getState();

      if (inner.type === 'iteration_started') {
        patchLiveAgentRun(runId, { iteration: inner.iteration });
      } else if (inner.type === 'text_delta') {
        agentRunStore.appendLiveTranscript(runId, 'assistant', { text: inner.delta });
      } else if (inner.type === 'thinking_delta') {
        agentRunStore.appendLiveTranscript(runId, 'reasoning', { text: inner.delta });
      } else if (inner.type === 'tool_use_completed') {
        // args 由模型产出、经 SSE JSON 到达；转写内容契约即 JSON。
        agentRunStore.appendLiveTranscript(runId, 'tool_call', {
          callId: inner.toolCallId, name: inner.toolName,
          args: inner.args as AgentRunMessageItem['content'],
        });
        const current = agentRunStore.runs.get(runId)?.live?.toolCallCount ?? 0;
        patchLiveAgentRun(runId, { toolCallCount: current + 1 });
      } else if (inner.type === 'tool_result') {
        agentRunStore.appendLiveTranscript(runId, 'tool_result', {
          callId: inner.result.toolCallId,
          content: inner.result.content,
          isError: inner.result.isError ?? false,
          errorCode: inner.result.errorCode,
          durationMs: inner.result.durationMs,
        });
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

    // ── Narrative ──────────────────────────────────────────────────────────

    case 'narrative_recall_started':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const slices = [
          ...sm.slices.filter((sl) => sl.type !== 'narrative_status'),
          {
            type: 'narrative_status' as const,
            status: 'running' as const,
            timelines: [],
            completedTimelines: [],
            snippets: {},
            failedTimelines: {},
          },
        ];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    case 'narrative_recall_completed':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const completedTimelines = event.timelines.map((timeline) => timeline.name);
        const slices = [
          ...sm.slices.filter((slice) => slice.type !== 'narrative_status'),
          {
            type: 'narrative_status' as const,
            status: 'completed' as const,
            timelines: [...event.timelineOrder],
            completedTimelines,
            snippets: Object.fromEntries(
              event.timelines.map((timeline) => [timeline.name, timeline.snippet]),
            ),
            failedTimelines: Object.fromEntries(
              event.failures.map((failure) => [failure.timeline, failure.message]),
            ),
          },
        ];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    case 'narrative_recall_failed':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const narrativeStatus = {
          type: 'narrative_status' as const,
          status: 'failed' as const,
          timelines: [],
          completedTimelines: [],
          snippets: {},
          failedTimelines: {},
          message: event.message,
        };
        const slices = [
          ...sm.slices.filter((slice) => slice.type !== 'narrative_status'),
          narrativeStatus,
        ];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    // ── Compact ────────────────────────────────────────────────────────────

    case 'compact_started':
    case 'compact_history_truncated':
    case 'compact_cancelled':
    case 'compact_failed':
      break;

    case 'compact_completed':
      useConversationStore.setState((s) => {
        const msgs    = new Map(s.messages);
        const existing = msgs.get(sessionId as string) ?? [];
        const notice = {
          role:      'system' as const,
          content:   `上下文已压缩 · 节省 ${event.savedTokens.toLocaleString()} tokens`,
          createdAt: Date.now(),
        };
        msgs.set(sessionId as string, [...existing, notice]);
        return { messages: msgs };
      });
      break;

    // ── Misc ───────────────────────────────────────────────────────────────

    case 'request_degraded':
      // 自动兼容不打断用户，但必须保留可诊断的结构化记录。
      console.info('[sse] request_degraded:', {
        sessionId: event.sessionId,
        turnId: event.turnId,
        attempt: event.attempt,
        reason: event.reason,
        removed: event.removed,
        replacements: event.replacements,
      });
      break;

    case 'turn_projection_warning':
      console.warn('[sse] turn_projection_warning:', {
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
