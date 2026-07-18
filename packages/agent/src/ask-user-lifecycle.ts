// 把 AskUser 的 Promise 等待接入 AgentTask CAS 状态机和 Turn 取消信号。

import type { AskUserQuestionSpec } from '@ema-agent/contracts';
import type { AskUserRegistryLike, IAgentTaskStore } from './types.js';

export interface AwaitAgentAnswerInput {
  taskId: string;
  promptId: string;
  questions: AskUserQuestionSpec[];
  turnId: string;
  signal: AbortSignal;
  registry: AskUserRegistryLike;
  taskStore?: IAgentTaskStore;
}

export async function awaitAgentAnswer(
  input: AwaitAgentAnswerInput,
): Promise<{ answers: Record<string, string> }> {
  const waiting = input.taskStore?.waitUser(input.taskId, input.promptId, input.questions);
  if (waiting && !waiting.ok) {
    throw new AgentTaskPromptConflictError(input.taskId, input.promptId, 'wait_user');
  }

  const { promise } = input.registry.createWithId(
    input.promptId,
    undefined,
    input.turnId,
  );
  if (input.signal.aborted) {
    input.registry.cancel(input.promptId);
    throw abortReason(input.signal);
  }

  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    input.registry.cancel(input.promptId);
    rejectAbort?.(abortReason(input.signal));
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const answers = await Promise.race([promise, aborted]);
    const resumed = input.taskStore?.userAnswered(input.taskId, input.promptId);
    if (resumed && !resumed.ok) {
      throw new AgentTaskPromptConflictError(input.taskId, input.promptId, 'user_answered');
    }
    return { answers };
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}

export class AgentTaskPromptConflictError extends Error {
  readonly code = 'agent_task/prompt_transition_conflict';

  constructor(
    readonly taskId: string,
    readonly promptId: string,
    readonly action: 'wait_user' | 'user_answered',
  ) {
    super(`Agent task prompt transition conflict: ${action}, task=${taskId}, prompt=${promptId}`);
    this.name = 'AgentTaskPromptConflictError';
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Agent ask-user wait aborted');
}
