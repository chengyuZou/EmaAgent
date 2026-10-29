import { z } from 'zod';
import { ComputerUseError } from './errors.js';
import {
  actionResultSchema,
  computerObservationSchema,
  computerWindowSchema,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerObservation,
  type ComputerTransport,
  type ComputerWindow,
  type NativeControlState,
} from './types.js';

export type ComputerCallKind = 'list' | 'observe' | 'action' | 'end';

interface ActiveComputerUse {
  // 哪个聊天的哪个 Turn 申请了这次操控. Turn 收尾时必须结束它.
  readonly sessionId: string;
  readonly turnId: string;
  readonly controlId: string;
  // starting 包括等用户批准和等 Rust 启动回应. 后续状态由 Rust 通知更新.
  phase: 'starting' | NativeControlState['phase'];
  // 等 Rust 回答"本次电脑操控已启动"的 Promise.
  // 还没发启动请求时是 null. 收到回应后仍保留.
  // 如果启动尚未回应就要求结束, 先等它回应, 再发送结束请求.
  computerUseStartPromise: Promise<unknown> | null;
}

interface PendingComputerCall {
  readonly sessionId: string;
  readonly turnId: string;
  // 这次 Tool 属于哪段电脑操控. 入队时尚未申请操控则为 null.
  // 首次申请时, 同 Turn 已排队的电脑 Tool 会一起指向这段操控.
  activeComputerUse: ActiveComputerUse | null;
  // 只表示正在等 Rust 回应, 不表示已经产生输入. 是否部分完成由 Rust 报告.
  awaitingNativeResponse: boolean;
  // 结束时记下这个旧调用不能再执行的原因. 后续启动也不清除.
  // undefined 表示这个调用尚未被作废.
  invalidationError?: ComputerUseError;
  // 通知工具执行器将这个 Tool 作为未执行结束. 已提交给 Rust 的请求不调用它.
  readonly rejectQueuedCall: (error: ComputerUseError) => void;
}

export interface ComputerUseState {
  readonly sessionId: string;
  readonly turnId: string;
  readonly controlId: string;
  readonly phase: ActiveComputerUse['phase'];
}

export class ComputerUse {
  // 当前这一次电脑操控. 等批准时也保留, 整段操控结束后清为 null.
  private currentActiveComputerUse: ActiveComputerUse | null = null;
  // 尚未处理完的电脑 Tool, key 是 ToolCallId. 结束时从这里找旧调用, 处理完后删除.
  private readonly pendingComputerCalls = new Map<string, PendingComputerCall>();
  // 通知其他业务电脑状态变了. 目前 vishot 用它取消旧截图流程并重新计时.
  private readonly stateChangeListeners = new Set<() => void>();
  // 用户结束操控的 Session 先记在这里. 收到新用户文本或 Ask 回答后才允许再次申请启动.
  // 允许申请不等于批准, 新的启动仍要经过 Permission.
  private readonly sessionsAwaitingUserInput = new Set<string>();
  private readonly unsubscribeNativeState: () => void;
  private isClosing = false;

  constructor(private readonly nativeProcess: ComputerTransport) {
    this.unsubscribeNativeState = nativeProcess.subscribe(state => this.handleNativeStateChange(state));
  }

  get state(): ComputerUseState | null {
    const activeComputerUse = this.currentActiveComputerUse;
    if (!activeComputerUse) return null;
    return {
      sessionId: activeComputerUse.sessionId,
      turnId: activeComputerUse.turnId,
      controlId: activeComputerUse.controlId,
      phase: activeComputerUse.phase,
    };
  }

  subscribe(listener: () => void): () => void {
    this.stateChangeListeners.add(listener);
    return () => { this.stateChangeListeners.delete(listener); };
  }

  /** 工具入队时记下它属于哪次电脑操控. 返回的函数在工具处理完后删除这条记录. */
  registerCall(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    kind: ComputerCallKind,
    rejectQueuedCall: (error: ComputerUseError) => void,
  ): () => void {
    if (this.isClosing) throw new ComputerUseError('computer/closed', '电脑操控已关闭.');
    if (this.currentActiveComputerUse && this.currentActiveComputerUse.turnId !== turnId) {
      throw new ComputerUseError('computer/busy', '电脑正在被另一个 Turn 使用.');
    }
    const call: PendingComputerCall = {
      sessionId,
      turnId,
      activeComputerUse: this.currentActiveComputerUse,
      awaitingNativeResponse: false,
      rejectQueuedCall,
    };
    this.pendingComputerCalls.set(toolCallId, call);
    if (this.currentActiveComputerUse?.phase === 'ending'
      || (!this.currentActiveComputerUse && this.sessionsAwaitingUserInput.has(sessionId) && kind !== 'end')) {
      this.invalidateCall(call, endedError());
    }
    return () => {
      this.pendingComputerCalls.delete(toolCallId);
      const activeComputerUse = call.activeComputerUse;
      // 启动被拒绝或取消时释放预约, 后面的同批调用也不能重新弹启动许可.
      if (activeComputerUse?.controlId === toolCallId && activeComputerUse.computerUseStartPromise === null) {
        this.finishComputerUse(activeComputerUse);
      }
    };
  }

  noteUserInput(sessionId: string): void {
    this.sessionsAwaitingUserInput.delete(sessionId);
  }

  /** 弹 Permission 前先为这个 Turn 留下电脑操控位置, 其他 Turn 此时不能同时申请. */
  reserve(toolCallId: string): void {
    const call = this.getExecutableCall(toolCallId);
    if (call.activeComputerUse) return;
    if (this.currentActiveComputerUse && this.currentActiveComputerUse.turnId !== call.turnId) {
      throw new ComputerUseError('computer/busy', '电脑正在被另一个 Turn 使用.');
    }
    const activeComputerUse: ActiveComputerUse = this.currentActiveComputerUse ?? {
      sessionId: call.sessionId,
      turnId: call.turnId,
      controlId: toolCallId,
      phase: 'starting',
      computerUseStartPromise: null,
    };
    // 在弹出批准框前填好已排队调用的记录, 包括后面可能紧跟着的 ComputerEnd.
    this.currentActiveComputerUse = activeComputerUse;
    for (const pending of this.pendingComputerCalls.values()) {
      if (pending.turnId === call.turnId && !pending.activeComputerUse && !pending.invalidationError) {
        pending.activeComputerUse = activeComputerUse;
      }
    }
    this.publish();
  }

  get needsStartupPermission(): boolean {
    return this.currentActiveComputerUse !== null && this.currentActiveComputerUse.computerUseStartPromise === null;
  }

  async listWindows(toolCallId: string, signal: AbortSignal): Promise<ComputerWindow[]> {
    this.getExecutableCall(toolCallId);
    const result = await this.nativeProcess.request({ method: 'computer.listWindows', params: {} }, signal);
    this.getExecutableCall(toolCallId);
    return z.array(computerWindowSchema).parse(result);
  }

  async capture(signal: AbortSignal): Promise<Buffer> {
    const result = z.object({ image: z.string() }).parse(await this.nativeProcess.request({
      method: 'computer.capture',
      params: {},
    }, signal));
    return Buffer.from(result.image, 'base64');
  }

  async observe(toolCallId: string, windowId: string, signal: AbortSignal): Promise<ComputerObservation> {
    const call = this.getExecutableCall(toolCallId);
    const activeComputerUse = call.activeComputerUse;
    if (!activeComputerUse) throw new ComputerUseError('computer/not_started', '请先启动电脑操控.');
    call.awaitingNativeResponse = true;
    try {
      if (activeComputerUse.controlId === toolCallId && activeComputerUse.computerUseStartPromise === null) {
        activeComputerUse.computerUseStartPromise = this.nativeProcess.request({
          method: 'computer.begin',
          params: { controlId: activeComputerUse.controlId },
        }, signal);
        try {
          await activeComputerUse.computerUseStartPromise;
        } catch (error) {
          this.finishComputerUse(activeComputerUse);
          throw error;
        }
      }
      this.getExecutableCall(toolCallId);
      const result = await this.nativeProcess.request({
        method: 'computer.observe',
        params: { controlId: activeComputerUse.controlId, windowId },
      }, signal);
      this.getExecutableCall(toolCallId);
      return computerObservationSchema.parse(result);
    } finally {
      call.awaitingNativeResponse = false;
    }
  }

  async act(toolCallId: string, observationId: string, action: ComputerAction, signal: AbortSignal): Promise<ComputerActionResult> {
    const call = this.getExecutableCall(toolCallId);
    const activeComputerUse = call.activeComputerUse;
    if (!activeComputerUse) throw new ComputerUseError('computer/not_started', '先调用 ObserveWindow 取得窗口和观察编号.');
    call.awaitingNativeResponse = true;
    try {
      // 已提交的动作由 Rust 返回实际效果, 不用 Node 的作废结果覆盖部分输入.
      return actionResultSchema.parse(await this.nativeProcess.request({
        method: 'computer.act',
        params: { controlId: activeComputerUse.controlId, observationId, action },
      }, signal));
    } finally {
      call.awaitingNativeResponse = false;
    }
  }

  async end(toolCallId: string, signal: AbortSignal): Promise<{ ended: boolean }> {
    const call = this.getExecutableCall(toolCallId);
    if (!call.activeComputerUse) return { ended: false };
    call.awaitingNativeResponse = true;
    try {
      await this.endComputerUse(call.activeComputerUse, 'agent_end', signal);
      return { ended: true };
    } finally {
      call.awaitingNativeResponse = false;
    }
  }

  /** Turn 收尾使用精确身份, 不能结束同 Session 后来启动的另一轮操控. */
  async endTurn(turnId: string): Promise<void> {
    const active = this.currentActiveComputerUse;
    if (active?.turnId === turnId) {
      await this.endComputerUse(active, 'cancelled', new AbortController().signal);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const activeComputerUse = this.currentActiveComputerUse;
    if (activeComputerUse?.sessionId === sessionId) {
      await this.endComputerUse(activeComputerUse, 'cancelled', new AbortController().signal);
    }
  }

  async close(): Promise<void> {
    this.isClosing = true;
    try {
      if (this.currentActiveComputerUse) await this.endComputerUse(this.currentActiveComputerUse, 'cancelled', new AbortController().signal);
    } finally {
      this.unsubscribeNativeState();
      await this.nativeProcess.close();
    }
  }

  private async endComputerUse(activeComputerUse: ActiveComputerUse, reason: 'agent_end' | 'cancelled', signal: AbortSignal): Promise<void> {
    activeComputerUse.phase = 'ending';
    this.invalidateCalls(activeComputerUse, endedError());
    this.publish();
    try {
      if (activeComputerUse.computerUseStartPromise) {
        // 可能刚发出启动请求就要求结束. 先等启动回应, 再告诉 Rust 结束这次操控.
        await activeComputerUse.computerUseStartPromise;
        await this.nativeProcess.request({
          method: 'computer.end',
          params: { controlId: activeComputerUse.controlId, reason },
        }, signal);
      }
    } finally {
      this.finishComputerUse(activeComputerUse);
    }
  }

  private handleNativeStateChange(state: NativeControlState): void {
    const activeComputerUse = this.currentActiveComputerUse;
    if (!activeComputerUse || activeComputerUse.controlId !== state.controlId) return;
    if (state.reason === 'user_end') this.sessionsAwaitingUserInput.add(activeComputerUse.sessionId);
    if (state.phase === 'ended') {
      this.finishComputerUse(activeComputerUse);
      return;
    }
    if (activeComputerUse.phase === 'ending' && state.phase !== 'ending') return;
    activeComputerUse.phase = state.phase;
    if (state.phase === 'ending') this.invalidateCalls(activeComputerUse, endedError());
    this.publish();
  }

  private invalidateCalls(activeComputerUse: ActiveComputerUse, error: ComputerUseError): void {
    for (const call of this.pendingComputerCalls.values()) {
      if (call.activeComputerUse === activeComputerUse) this.invalidateCall(call, error);
    }
  }

  private invalidateCall(call: PendingComputerCall, error: ComputerUseError): void {
    if (call.invalidationError) return;
    call.invalidationError = error;
    if (!call.awaitingNativeResponse) call.rejectQueuedCall(error);
  }

  private finishComputerUse(activeComputerUse: ActiveComputerUse): void {
    activeComputerUse.phase = 'ended';
    this.invalidateCalls(activeComputerUse, endedError());
    if (this.currentActiveComputerUse === activeComputerUse) this.currentActiveComputerUse = null;
    this.publish();
  }

  private getExecutableCall(toolCallId: string): PendingComputerCall {
    const call = this.pendingComputerCalls.get(toolCallId);
    if (!call) throw new ComputerUseError('computer/unregistered_call', '电脑工具尚未登记.');
    if (call.invalidationError) throw call.invalidationError;
    if (this.isClosing) throw new ComputerUseError('computer/closed', '电脑操控已关闭.');
    return call;
  }

  private publish(): void {
    for (const listener of this.stateChangeListeners) listener();
  }
}

function endedError(): ComputerUseError {
  return new ComputerUseError('computer/control_ended', '本次电脑控制已结束, 此调用未执行.');
}
