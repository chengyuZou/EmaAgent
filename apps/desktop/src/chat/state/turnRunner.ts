// 发送管线：per-session 队列、POST /turns、Turn SSE 生命周期、停止与会话资源回收。
import { createSendQueue, type SendQueue } from '../../lib/send-queue.js';
import { createTurnAcceptance, type TurnAcceptance } from '../../lib/turn-acceptance.js';
import { startTurnSseLifecycle } from '../../lib/turn-sse-lifecycle.js';
import { handleTurnAborted, evictSessionPlayers } from '../../lib/tts-playback.js';
import { sessionsApi } from '../../api/sessions.js';
import { turnsApi, type TurnCreateInput, type TurnAttachmentInput } from '../../api/turns.js';
import type { TurnCreatedResponse } from '../../api/turns.js';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';
import { useAgentRunStore } from '../../stores/agentRun.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useSessionStore } from '../../stores/session.js';
import { useTaskStore } from '../../stores/task.js';
import { useSessionHistory } from '../history/sessionHistory.js';
import { useCurrentSession } from './currentSession.js';
import { useMessages } from './messages.js';
import { dispatchTurnEvent } from './turnEvents.js';
import type { TurnInputPart } from '@ema-agent/turn';

// ── 输入 ──────────────────────────────────────────────────────────────────────

export interface SendInput {
  readonly sessionId: string;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  /** 保序输入段：text/attachment/skill，数组顺序即持久化与展示顺序。 */
  readonly parts: readonly TurnInputPart[];
  /** 本 Turn 的完整模型覆盖；缺省使用 Session 当前选择。 */
  readonly modelSelection?: TurnCreateInput['modelSelection'];
  /** 本 Turn 在当前激活知识库内的文档范围；缺省整个激活库。 */
  readonly knowledgeAssetIds?: string[];
  readonly ttsEnabled?: boolean;
}

interface QueuedSendInput extends SendInput {
  acceptance: TurnAcceptance<TurnCreatedResponse>;
}

// ── per-session 资源 ──────────────────────────────────────────────────────────

const sseHandles = new Map<string, { stop(): void }>();
const sendQueues = new Map<string, SendQueue<QueuedSendInput>>();

/** 输入段即线上 TurnInputPart，直通不做映射。 */
function buildInputParts(input: SendInput): TurnCreateInput['input'] {
  return [...input.parts];
}

function getOrCreateQueue(sessionId: string): SendQueue<QueuedSendInput> {
  const found = sendQueues.get(sessionId);
  if (found) return found;

  const queue = createSendQueue<QueuedSendInput>({
    async handler(input) {
      const { turnId, sessionId: actualSessionId } = await turnsApi.create({
        sessionId: input.sessionId,
        executionProfile: input.executionProfile,
        narrativePolicy: input.narrativePolicy,
        input: buildInputParts(input),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.knowledgeAssetIds && input.knowledgeAssetIds.length > 0
          ? { knowledge: { assetIds: input.knowledgeAssetIds } }
          : {}),
        ...(input.ttsEnabled !== undefined ? { ttsEnabled: input.ttsEnabled } : {}),
      });
      input.acceptance.accept({ turnId, sessionId: actualSessionId });

      if (actualSessionId !== input.sessionId) {
        void useSessionStore.getState().loadSessions();
        useCurrentSession.setState({ viewedSessionId: actualSessionId });
      }

      // Turn 生命周期统一持有当前连接和待重连计时器，用户停止时两者会一起取消。
      const lifecycle = startTurnSseLifecycle({
        openResponse: (signal, lastEventId) => turnsApi.openEvents(turnId, lastEventId, signal),
        onEvent(event) {
          const sid = ('sessionId' in event && event.sessionId)
            ? event.sessionId
            : input.sessionId;
          dispatchTurnEvent(event, sid);
        },
        onPermanentDisconnect(error) {
          console.error('[turn-runner] SSE failed permanently', error);
          useMessages.getState().abortStream(input.sessionId, `连接中断：${error.message}`);
        },
      });
      sseHandles.set(input.sessionId, lifecycle);
      await lifecycle.done;

      if (sseHandles.get(input.sessionId) === lifecycle) {
        sseHandles.delete(input.sessionId);
      }
    },
    continueOnError: true,
  });

  sendQueues.set(sessionId, queue);
  return queue;
}

// ── 公开入口 ──────────────────────────────────────────────────────────────────

/** Turn 创建成功后 resolve；后续 SSE 生命周期由会话状态独立管理。 */
export async function sendMessage(
  sessionId: string | null,
  input: Omit<SendInput, 'sessionId'>,
): Promise<void> {
  let targetId = sessionId;
  let createdNewSession = false;

  if (!targetId) {
    const newSession = await sessionsApi.create();
    targetId = newSession.id;
    createdNewSession = true;
    void useSessionStore.getState().loadSessions();
    useCurrentSession.setState({ viewedSessionId: targetId });
  }
  useSessionHistory.getState().showTail(targetId);

  // 乐观输入只活到后端持久消息经重拉就位为止（见 beginStream 的重拉）。
  useMessages.getState().setPendingInput(targetId, {
    parts: input.parts,
    createdAt: Date.now(),
  });

  const acceptance = createTurnAcceptance<TurnCreatedResponse>();
  const completion = getOrCreateQueue(targetId).enqueue({
    ...input,
    sessionId: targetId,
    acceptance,
  });
  void completion.catch((error: unknown) => acceptance.reject(error));
  const accepted = await acceptance.promise;
  const acceptedSessionId = accepted.sessionId;

  // 附件在 POST /turns 返回前已经持久化；面板若已加载，立即刷新当前 Session，
  // 未打开过的会话不额外发请求，首次打开时再按需加载。
  if (input.parts.some((part) => part.type === 'attachment')
    && useSessionAttachmentStore.getState().bySession.has(acceptedSessionId)) {
    void useSessionAttachmentStore.getState()
      .loadForSession(acceptedSessionId, true)
      .catch(() => {});
  }

  if (createdNewSession) {
    useMessages.setState((s) => {
      const loadedSessions = new Set(s.loadedSessions);
      loadedSessions.add(acceptedSessionId);
      return { loadedSessions };
    });
  }
  useSessionHistory.getState().invalidateTurnIndex(acceptedSessionId);
}

/** 停止是 Session 级操作：只断开 SSE 不会停止后端执行；界面收口与中止信号并行。 */
export function stopStreaming(sessionId: string): void {
  void sessionsApi.abort(sessionId).catch(() => {});
  sseHandles.get(sessionId)?.stop();
  sseHandles.delete(sessionId);
  handleTurnAborted(sessionId);
  useMessages.getState().abortStream(sessionId, '已停止');
}

/** 会话删除时的聊天域资源回收编排。 */
export function evictChatSession(sessionId: string): void {
  sseHandles.get(sessionId)?.stop();
  sseHandles.delete(sessionId);
  sendQueues.get(sessionId)?.clear();
  sendQueues.delete(sessionId);
  evictSessionPlayers(sessionId);
  useAgentRunStore.getState().evictSession(sessionId);
  useSessionAttachmentStore.getState().evictSession(sessionId);
  useSessionHistory.getState().evictSession(sessionId);
  useTaskStore.getState().evictSession(sessionId);
  useMessages.getState().evictSession(sessionId);
  useCurrentSession.getState().evictSession(sessionId);
}
