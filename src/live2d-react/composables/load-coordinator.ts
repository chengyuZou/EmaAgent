// 管理 Live2D 模型异步加载的代次、取消信号与当前任务归属。

export interface Live2DLoadScope {
  readonly id: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  cancel(): void;
}

interface LoadState {
  readonly id: number;
  readonly abortController: AbortController;
  cancelled: boolean;
}

export class Live2DLoadCoordinator {
  private nextId = 0;
  private active: LoadState | null = null;

  begin(): Live2DLoadScope {
    this.cancelState(this.active);

    const state: LoadState = {
      id: ++this.nextId,
      abortController: new AbortController(),
      cancelled: false,
    };
    this.active = state;

    return {
      id: state.id,
      signal: state.abortController.signal,
      isCurrent: () => this.active === state && !state.cancelled,
      cancel: () => {
        this.cancelState(state);
        if (this.active === state) this.active = null;
      },
    };
  }

  private cancelState(state: LoadState | null): void {
    if (!state || state.cancelled) return;
    state.cancelled = true;
    state.abortController.abort();
  }
}
