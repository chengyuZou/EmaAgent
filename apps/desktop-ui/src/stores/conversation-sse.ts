// 把 Turn 的结构化 SSE 事件分发给会话状态和各业务 Store。
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
import { useAgentRunStore }        from './agentRunStore.js';
import { useTaskStore }            from './taskStore.js';
import { useConversationStore }    from './conversation-store.js';
import { useContextUsageStore }    from './contextUsageStore.js';
import {
  appendTextSlice,
  appendThinkingSlice,
  } from './conversation-history.js';
import type {
  SessionId,
  TurnId,
} from '@ema-agent/ids';
import type { ToolPresentation } from '@ema-agent/tools';
import {
  type ExecutionProfile,
  type NarrativePolicy,
  TurnStats,
} from '@ema-agent/turn';
import type { TurnStreamEvent } from '@ema-agent/events';
import type {
  MemoryRecallLayer,
  MemoryRecallLayerReport,
} from '@ema-agent/memory';

// ── StreamCallbacks ───────────────────────────────────────────────────────────

export type DeltaSlice = 'text' | 'thinking' | 'tool_use' | 'tool_result';
export type DeltaPayload =
  | string
  | { callId: string; name: string; args: unknown }
  | { callId: string; output?: unknown; presentation?: ToolPresentation; error?: { code: string; message: string }; durationMs?: number };

export interface StreamCallbacks {
  beginStream(
    sessionId: SessionId,
    turnId: TurnId,
    executionProfile: ExecutionProfile,
    narrativePolicy: NarrativePolicy,
  ): void;
  appendDelta(sessionId: SessionId, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: SessionId, stats: TurnStats | null): void;
  abortStream(sessionId: SessionId, reason: string): void;
}

// ── Module-level temp state ───────────────────────────────────────────────────

// Breaker reasons arrive before turn_aborted; we hold them here for lookup.
export const breakerReasons = new Map<string, string>();

// ── Main dispatcher ───────────────────────────────────────────────────────────

export function dispatchSseEvent(
  event:     TurnStreamEvent,
  sessionId: SessionId,
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
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    case 'turn_failed':
      breakerReasons.delete(sessionId as string);
      handleTurnAborted(sessionId as string);
      cb.abortStream(sessionId, event.message);
      void tauriBridge.emit('speech:end', { sessionId });
      break;

    case 'turn_aborted': {
      const reason = breakerReasons.get(sessionId as string);
      breakerReasons.delete(sessionId as string);
      handleTurnAborted(sessionId as string);
      cb.abortStream(sessionId, reason ?? event.reason);
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

    case 'llm_context_prepared':
      useContextUsageStore.getState().applyEstimate(
        sessionId as string,
        event.llmCallId as string,
        event.estimate,
      );
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
        presentation: event.presentation,
        error: event.error,
        durationMs: event.durationMs,
      });
      break;

    // ── Decision events — push to decision-store + relay to pet window ────

    case 'ask_user_required': {
      const p = {
        kind: 'ask_user' as const, promptId: event.promptId, sessionId,
        turnId: event.turnId, questions: event.questions, humanDescription: event.humanDescription,
      };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      break;
    }
    case 'ask_user_resolved':
      useDecisionStore.getState().dismiss(event.promptId);
      void tauriBridge.emit('decision:dismiss', { promptId: event.promptId });
      break;

    case 'ask_confirm_required': {
      const p = {
        kind: 'ask_confirm' as const, promptId: event.promptId, turnId: event.turnId,
        sessionId, question: event.question, humanDescription: event.humanDescription,
      };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      break;
    }
    case 'ask_confirm_resolved':
      useDecisionStore.getState().dismiss(event.promptId);
      void tauriBridge.emit('decision:dismiss', { promptId: event.promptId });
      break;

    case 'ask_text_required': {
      const p = {
        kind: 'ask_text' as const, promptId: event.promptId, turnId: event.turnId,
        sessionId, question: event.question,
        humanDescription: event.humanDescription, placeholder: event.placeholder,
      };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      break;
    }
    case 'ask_text_resolved':
      useDecisionStore.getState().dismiss(event.promptId);
      void tauriBridge.emit('decision:dismiss', { promptId: event.promptId });
      break;

    case 'ask_choice_required': {
      const p = {
        kind: 'ask_choice' as const, promptId: event.promptId, turnId: event.turnId,
        sessionId, question: event.question,
        humanDescription: event.humanDescription, options: event.options,
        multiSelect: event.multiSelect ?? false, allowCustom: event.allowCustom,
      };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      break;
    }
    case 'ask_choice_resolved':
      useDecisionStore.getState().dismiss(event.promptId);
      void tauriBridge.emit('decision:dismiss', { promptId: event.promptId });
      break;

    case 'permission_required': {
      const p = {
        kind: 'permission' as const, promptId: event.promptId, sessionId,
        turnId: event.turnId,
        toolId: event.toolId, toolName: event.tool, toolDescription: event.toolDescription,
        args: event.args, hint: event.hint, riskLevel: event.riskLevel,
        accessType: event.accessType, gateReason: event.gateReason,
        humanDescription: event.humanDescription,
        // LLM 解释尚未开始时不能显示加载态；后续由用户点击“解释”后再局部置为 true。
        humanDescriptionPending: false,
      };
      useDecisionStore.getState().push(p);
      void tauriBridge.emit('decision:push', p);
      // 使用后端提供的 ToolCallId 精确关联；同名工具允许在一个 Turn 内并发。
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        let set = false;
        const slices = sm.slices.map((sl) => {
          if (set) return sl;
          if (sl.type === 'tool_use' && sl.callId === event.callId) {
            set = true;
            return { ...sl, permissionPromptId: event.promptId };
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
      useDecisionStore.getState().dismiss(event.promptId);
      void tauriBridge.emit('decision:dismiss', { promptId: event.promptId });
      // allow → 清掉 permissionPromptId 恢复运行中；deny → 不在此标失败，等后端 tool_result(permission/denied) 统一处理
      if (event.decision === 'allow') {
        useConversationStore.setState((s) => {
          const sm = s.streamingMap.get(sessionId as string);
          if (!sm) return {};
          const slices = sm.slices.map((sl) =>
            sl.type === 'tool_use' && sl.permissionPromptId === event.promptId
              ? { ...sl, permissionPromptId: undefined }
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

    // ── 持久 Task ─────────────────────────────────────────────────────────

    case 'task_created':
    case 'task_updated':
      useTaskStore.getState().upsert(event.task);
      break;

    case 'task_deleted':
      useTaskStore.getState().remove(event.sessionId, event.taskId);
      break;

    // ── Agent events ───────────────────────────────────────────────────────

    case 'agent_breaker_tripped':
      breakerReasons.set(sessionId as string, `熔断保护：${event.reason}`);
      break;

    case 'agent_iteration':
      useConversationStore.setState((s) => {
        const m = new Map(s.iterationCountMap);
        m.set(sessionId as string, event.n);
        return { iterationCountMap: m };
      });
      break;

    // ── Subagent lifecycle ─────────────────────────────────────────────────

    case 'subagent_started':
      useAgentRunStore.getState().upsert({
        id: event.subagentId,
        sessionId: event.sessionId as string,
        parentTurnId: event.parentTurnId as string,
        kind: event.kind,
        purpose: event.description ?? event.promptExcerpt,
        modelId: event.model,
        status: 'running',
        version: 0,
        createdAt: event.startedAtMs, updatedAt: event.startedAtMs,
        live: {
          startedAtMs: event.startedAtMs, promptExcerpt: event.promptExcerpt,
          model: event.model, iteration: 0, toolCallCount: 0, elapsedMs: 0,
        },
      });
      // 先建立空记录，让详情面板无需等待持久快照即可展示流式内容。
      useAgentRunStore.setState((s) => {
        if (s.transcripts.has(event.subagentId)) return {};
        const trans = new Map(s.transcripts);
        trans.set(event.subagentId, []);
        return { transcripts: trans };
      });
      break;

    case 'subagent_progress': {
      const existing = useAgentRunStore.getState().runs.get(event.subagentId);
      useAgentRunStore.getState().upsert({
        id: event.subagentId, status: 'running',
        live: {
          startedAtMs:   existing?.live?.startedAtMs   ?? Date.now(),
          promptExcerpt: existing?.live?.promptExcerpt ?? '',
          model:         existing?.live?.model         ?? '',
          iteration:     event.iteration,
          toolCallCount: event.toolCallCount,
          elapsedMs:     event.elapsedMs,
        },
      });
      break;
    }

    case 'subagent_completed':
      useAgentRunStore.getState().upsert({
        id: event.subagentId, status: 'completed', updatedAt: Date.now(),
        iterations: event.iterationCount,
        toolCallCount: event.toolCallCount,
        inputTokens: event.stats.inputTokens, outputTokens: event.stats.outputTokens,
        outputExcerpt: event.outputExcerpt,
        completedAt: Date.now(),
        live: undefined,
      });
      break;

    case 'subagent_failed':
      useAgentRunStore.getState().upsert({
        id: event.subagentId, status: 'failed', error: event.error,
        updatedAt: Date.now(), completedAt: Date.now(), live: undefined,
      });
      break;

    case 'subagent_aborted':
      useAgentRunStore.getState().upsert({
        id: event.subagentId, status: 'cancelled', error: event.reason,
        updatedAt: Date.now(), completedAt: Date.now(), live: undefined,
      });
      break;

    case 'subagent_stream': {
      const { ev: inner, subagentId } = event;
      const agentRunStore = useAgentRunStore.getState();

      if (inner.type === 'text_delta') {
        agentRunStore.appendLiveTranscript(subagentId, 'assistant', { text: inner.delta });
      } else if (inner.type === 'reasoning_delta') {
        agentRunStore.appendLiveTranscript(subagentId, 'reasoning', { text: inner.delta });
      } else if (inner.type === 'tool_call') {
        agentRunStore.appendLiveTranscript(subagentId, 'tool_call', {
          callId: inner.callId, name: inner.name, args: inner.args,
          iteration: inner.iteration,
        });
      } else if (inner.type === 'tool_result') {
        agentRunStore.appendLiveTranscript(subagentId, 'tool_result', {
          callId: inner.callId, name: inner.name, excerpt: inner.excerpt,
          isError: inner.isError, error: inner.error?.message, durationMs: inner.durationMs,
        });
      }
      // iteration — no transcript entry needed
      break;
    }

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

    // ── Memory ─────────────────────────────────────────────────────────────

    case 'context_compaction_started':
      break;

    case 'context_compaction_failed':
      break;

    case 'context_compaction_completed':
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

    case 'memory_recall_evidence':
      useConversationStore.setState((s) => {
        const prev = s.recallEvidenceMap.get(sessionId as string) ?? {};
        const next  = new Map(s.recallEvidenceMap);
        next.set(sessionId as string, {
          ...prev,
          [event.layer as MemoryRecallLayer]: event.report as MemoryRecallLayerReport,
        });
        return { recallEvidenceMap: next };
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
