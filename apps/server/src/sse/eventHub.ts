// 事件扇出枢纽：Turn 流按 turnId 定向，应用事件全局广播；单个订阅者异常不拖垮其他连接。
import type { CharacterEvent } from '@ema-agent/characters';
import type { KnowledgeEvent } from '@ema-agent/knowledge';
import type { SpeechEvent } from '@ema-agent/speech';
import type { SystemWarningEvent } from '@ema-agent/system';
import type { BackgroundProcessEvent } from '@ema-agent/tools';
import type { TurnEvent, TurnStreamEvent } from '@ema-agent/turn';

/** Turn 事件端点的线上形状：Turn 流 + 语音输出事件（Speech 是 Turn 流的可选消费者）。 */
export type TurnWireEvent = TurnStreamEvent | SpeechEvent;

export interface PublishedTurnEvent {
  /** Turn 内从 1 开始的事件游标；客户端提交最后已消费游标，服务端只发送更大值。 */
  readonly cursor: number;
  readonly event: TurnWireEvent;
}

/** MCP stdio 拉起的批准请求：应用级询问，不进入任何 Session 的交互队列。 */
export interface McpStdioApprovalRequest {
  readonly requestId: string;
  readonly operation: 'connect' | 'probe';
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** 环境变量只展示键名；值可能含密钥，绝不进事件。 */
  readonly environmentKeys: readonly string[];
  readonly createdAt: number;
}

/** Turn 生命周期的应用级回声（侧栏等跨 Session 视图消费）；事件本体与 Turn 流内一致。 */
export type TurnActivityEvent = Extract<
  TurnEvent,
  { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
>;

/** 应用级事件：不属于单个 Turn 流的全局事实与询问。系统事件无重放，迟到订阅者错过即过。 */
export type AppEvent =
  | BackgroundProcessEvent
  | KnowledgeEvent
  | CharacterEvent
  | TurnActivityEvent
  | SystemWarningEvent
  | { readonly type: 'session_title_updated'; readonly sessionId: string; readonly title: string }
  | { readonly type: 'settings_changed'; readonly changedKeys: readonly string[]; readonly revision: number }
  | { readonly type: 'mcp_stdio_launch_required'; readonly request: McpStdioApprovalRequest };

export class EventHub {
  private readonly turnSubscribers = new Map<string, Set<(published: PublishedTurnEvent) => void>>();
  private readonly appSubscribers = new Set<(event: AppEvent) => void>();

  subscribeTurn(turnId: string, listener: (published: PublishedTurnEvent) => void): () => void {
    let set = this.turnSubscribers.get(turnId);
    if (!set) {
      set = new Set();
      this.turnSubscribers.set(turnId, set);
    }
    set.add(listener);
    return () => {
      const current = this.turnSubscribers.get(turnId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.turnSubscribers.delete(turnId);
    };
  }

  publishTurn(turnId: string, published: PublishedTurnEvent): void {
    const set = this.turnSubscribers.get(turnId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(published);
      } catch {
        // 单个失效连接不能阻止其他客户端收到同一事件；连接清理归路由取消路径。
      }
    }
  }

  subscribeApp(listener: (event: AppEvent) => void): () => void {
    this.appSubscribers.add(listener);
    return () => { this.appSubscribers.delete(listener); };
  }

  emitApp(event: AppEvent): void {
    for (const listener of [...this.appSubscribers]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[event-hub] 应用事件订阅者异常:', error);
      }
    }
  }

  turnSubscriberCount(turnId?: string): number {
    if (turnId) return this.turnSubscribers.get(turnId)?.size ?? 0;
    let total = 0;
    for (const set of this.turnSubscribers.values()) total += set.size;
    return total;
  }

  /** 诊断用：应用通道当前订阅者数。 */
  appSubscriberCount(): number {
    return this.appSubscribers.size;
  }

  appSubscriberCount(): number {
    return this.appSubscribers.size;
  }
}
