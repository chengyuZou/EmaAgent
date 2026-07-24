// 把 Tools 的窄生命周期观察端口接到 HookBus，并将 Hook 警告送回当前执行流。
import type { HookBus, HookWarningEvent } from '@ema-agent/hooks';
import type { ToolLifecycleObserver } from '@ema-agent/tools';

export function createToolLifecycleHooks(
  hooks: HookBus,
  emit: (event: HookWarningEvent) => void,
): ToolLifecycleObserver {
  return {
    async beforeToolUse(input, context): Promise<void> {
      await hooks.trigger('beforeToolUse', {
        turnId: context.turnId,
        sessionId: context.sessionId,
        payload: input,
        signal: context.signal,
        emit,
      });
    },
    async afterToolUse(input, context): Promise<void> {
      await hooks.trigger('afterToolUse', {
        turnId: context.turnId,
        sessionId: context.sessionId,
        payload: input,
        signal: context.signal,
        emit,
      });
    },
    async onToolFailure(input, context): Promise<void> {
      await hooks.trigger('onToolFailure', {
        turnId: context.turnId,
        sessionId: context.sessionId,
        payload: input,
        signal: context.signal,
        emit,
      });
    },
  };
}
