// 表示发送队列中的请求何时真正被后端创建为 Turn。

export interface TurnAcceptance<T> {
  readonly promise: Promise<T>;
  accept(value: T): void;
  reject(reason: unknown): void;
}

export function createTurnAcceptance<T>(): TurnAcceptance<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    accept(value) {
      if (settled) return;
      settled = true;
      resolvePromise?.(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      rejectPromise?.(reason);
    },
  };
}
