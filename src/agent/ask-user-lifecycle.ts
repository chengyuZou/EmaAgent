// 把根 Turn 的 AskUser Promise 等待接入取消信号。

import type { AskUserRequiredEvent } from '@ema-agent/turn';
import type { AskUserRegistryLike } from './types.js';

export interface AwaitAgentAnswerInput {
  promptId: string;
  request: AskUserRequiredEvent;
  turnId: string;
  signal: AbortSignal;
  registry: AskUserRegistryLike;
}

export async function awaitAgentAnswer(
  input: AwaitAgentAnswerInput,
): Promise<{ answers: Record<string, string> }> {
  const { promise } = input.registry.createWithId(
    input.promptId,
    undefined,
    input.turnId,
    input.request,
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
    return { answers };
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Agent ask-user wait aborted');
}
