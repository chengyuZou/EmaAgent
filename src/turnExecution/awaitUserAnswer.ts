// 把根 Turn 的 AskUser 等待接入取消信号，并在取消时清理交互队列。

import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { AskUserInteractionPort } from './types.js';

export interface AwaitUserAnswerInput {
  promptId: string;
  request: AskUserRequiredEvent;
  turnId: string;
  signal: AbortSignal;
  interaction: AskUserInteractionPort;
}

export async function awaitUserAnswer(
  input: AwaitUserAnswerInput,
): Promise<{ answers: Record<string, string> }> {
  const { promise } = input.interaction.createWithId(
    input.promptId,
    undefined,
    input.turnId,
    input.request,
  );
  if (input.signal.aborted) {
    input.interaction.cancel(input.promptId);
    throw abortReason(input.signal);
  }

  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    input.interaction.cancel(input.promptId);
    rejectAbort?.(abortReason(input.signal));
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const outcome = await Promise.race([promise, aborted]);
    if (outcome.status === 'answered') {
      return { answers: { ...outcome.answers } };
    }
    throw new Error(`AskUser ${outcome.status}: ${outcome.reason}`);
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Turn ask-user wait aborted');
}
