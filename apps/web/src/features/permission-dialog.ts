import type { PermissionDecision, PermissionGrantScope, PermissionRequest } from "@ema-agent/permission"

export interface PermissionDialogState {
  open: boolean
  request?: PermissionRequest
  submitting: boolean
  error?: string
}

export interface PermissionDialogController {
  getState(): PermissionDialogState
  subscribe(listener: (state: PermissionDialogState) => void): () => void
  show(request: PermissionRequest): void
  resolve(decision: Exclude<PermissionDecision, "prompt">, scope: PermissionGrantScope): Promise<void>
  close(): void
}

export interface PermissionDialogControllerOptions {
  onResolve(input: {
    request: PermissionRequest
    decision: Exclude<PermissionDecision, "prompt">
    scope: PermissionGrantScope
  }): Promise<void> | void
}

/**
 * 权限确认弹窗的 headless controller。
 *
 * UI 组件只根据 state.open 渲染弹窗，并调用 resolve() 提交允许/拒绝。
 */
export function createPermissionDialogController(options: PermissionDialogControllerOptions): PermissionDialogController {
  let state: PermissionDialogState = {
    open: false,
    submitting: false,
  }
  const listeners = new Set<(state: PermissionDialogState) => void>()

  const setState = (patch: Partial<PermissionDialogState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state)
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },

    show(request) {
      setState({
        open: true,
        request,
        submitting: false,
        error: undefined,
      })
    },

    async resolve(decision, scope) {
      if (!state.request) {
        return
      }

      setState({ submitting: true, error: undefined })
      try {
        await options.onResolve({
          request: state.request,
          decision,
          scope,
        })
        setState({
          open: false,
          request: undefined,
          submitting: false,
        })
      } catch (error) {
        setState({
          submitting: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    close() {
      setState({
        open: false,
        request: undefined,
        submitting: false,
        error: undefined,
      })
    },
  }
}
