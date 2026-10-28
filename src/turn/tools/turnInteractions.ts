import {
  rememberSessionApproval,
  type PermissionRequest,
  type PermissionUserResponse,
  type SessionPermissionApproval,
} from '@ema-agent/permission';
import type { AskUser, AskUserRequiredEvent } from '@ema-agent/tools';
import type { PrepareTurnToolsInput, TurnToolsDeps } from './turnTools.js';

export function createTurnInteractions(
  deps: Pick<TurnToolsDeps, 'interactionQueue' | 'publishInteraction' | 'computerUse'>,
  input: Pick<PrepareTurnToolsInput, 'sessionId' | 'turnId'>,
) {
  const { sessionId, turnId } = input;
  // 主 Agent 与前后台子代理共用这条 Session 交互通道.
  const askPermission = async (
    request: PermissionRequest,
    signal: AbortSignal,
    sessionApproval: SessionPermissionApproval | undefined,
  ): Promise<PermissionUserResponse> => {
    const { promise } = deps.interactionQueue.enqueuePermission(request);
    // 先建立可回答的队列条目, 再发布事件. 子代理不借父 Turn 通道.
    deps.publishInteraction({ type: 'permission_required', ...request });
    const response = await awaitInteraction(promise, signal, () => {
      deps.interactionQueue.cancel(request.toolCallId, 'tool aborted');
    });
    if (response.action === 'allowSession' && sessionApproval) {
      rememberSessionApproval(sessionId, sessionApproval.key);
    }
    const resolved = {
      type: 'permission_resolved' as const,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      decision: response.action === 'deny' ? 'deny' as const : 'allow' as const,
    };
    if (request.subagentId !== undefined) {
      deps.publishInteraction({ ...resolved, subagentId: request.subagentId, runId: request.runId });
    } else {
      deps.publishInteraction(resolved);
    }
    return response;
  };

  const askUser: AskUser = async (toolCallId, specs, signal) => {
    const request: AskUserRequiredEvent = {
      type: 'ask_user_required',
      sessionId,
      turnId,
      toolCallId,
      questions: [...specs],
    };
    const { promise } = deps.interactionQueue.enqueueAskUser(request);
    deps.publishInteraction(request);
    const outcome = await awaitInteraction(promise, signal, () => {
      deps.interactionQueue.cancel(toolCallId, 'turn aborted');
    });
    // 取消/超时也要发空答案清前端卡片: 空答案 resolved 是清卡信号, 不是成功
    deps.publishInteraction({
      type: 'ask_user_resolved',
      sessionId,
      toolCallId,
      answers: outcome.status === 'answered' ? { ...outcome.answers } : {},
    });
    if (outcome.status === 'answered') {
      deps.computerUse?.noteUserInput(sessionId);
      return { answers: { ...outcome.answers } };
    }
    throw new Error(`AskUser ${outcome.status}: ${outcome.reason}`);
  };

  return { askPermission, askUser };
}

/**
 * 队列条目在 cancel 时会以其默认终态 resolve(permission→deny,askUser→cancelled),
 * 因此这里只需在 abort 时撤销条目并等待同一个 Promise 收尾.
 */
async function awaitInteraction<T>(promise: Promise<T>, signal: AbortSignal, cancel: () => void): Promise<T> {
  if (signal.aborted) {
    cancel();
    return promise;
  }
  const onAbort = (): void => cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await promise;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
