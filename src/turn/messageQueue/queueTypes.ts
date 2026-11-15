import type { SubagentStatus } from '@ema-agent/agent';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import type { TurnInputPart } from '../types.js';

/** 决定一条排队的用户输入何时交付给会话执行. */
export type QueueMessageDelivery = 'next_turn' | 'next_iteration';

/** SessionMessageQueue 为 Turn 执行生成的存储消息类型. */
export type QueueMessageKind = 'normal' | 'continuation';

/**
 * 前端队列卡片与 WebSocket 事件共用的排队输入公开结构.
 * `'next_turn'` 等会话完全空闲(包含手动压缩结束)后再启动新 Turn.
 * `'next_iteration'` 在当前 AgentLoop 到达安全迭代边界时注入; 若本轮先结束, 则随下一 Turn 交付.
 */
export interface QueuedSessionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly input: readonly TurnInputPart[];
  readonly createdAt: number;
  readonly delivery: QueueMessageDelivery;
}

/**
 * Session WebSocket 推送的队列增量事件.
 * 连接初始化的当前列表随 `session_state` 下发; 消息正式保存由 `user_messages_stored` 通知已消费的 `queuedInputIds`.
 */
export type SessionMessageQueueEvent =
  | { readonly type: 'queued_input_added'; readonly queuedInput: QueuedSessionInput }
  | { readonly type: 'queued_input_removed'; readonly queuedInputId: string }
  | { readonly type: 'queued_input_delivery_changed'; readonly queuedInput: QueuedSessionInput }
  | { readonly type: 'queued_inputs_returned'; readonly queuedInputs: readonly QueuedSessionInput[] };

/**
 * SessionMessageQueue 为 Turn 交付的单条待落库消息载荷(对应未来 Messages 表的一行).
 * 一批预留可包含多条 `QueueMessage`; 预留本身不会删除队列条目:
 * 调用方在写库成功后必须调用 `confirmMessageSaved` 提交消费, 准备或写库失败则调用 `releaseReservedMessage` 退回预留.
 */
export interface QueueMessage {
  readonly messageKind: QueueMessageKind;
  readonly input: readonly TurnInputPart[];
}

/**
 * 子代理或后台命令写入终态和完整输出后, 提交给 SessionMessageQueue 的轻量完成通知输入.
 */
export type BackgroundCompletionInput =
  | {
      readonly sessionId: string;
      readonly source: 'subagent_completed';
      readonly subagentId: string;
      readonly status: Exclude<SubagentStatus, 'running'>;
    }
  | {
      readonly sessionId: string;
      readonly source: 'background_process_completed';
      readonly backgroundProcessId: string;
      readonly status: BackgroundProcessNotifiableStatus;
    };

/**
 * 尚未提交写入 Messages 表的排队用户输入(只存在当前进程内存中).
 * 删除与切换交付时机时会检查 `unconfirmedReservationsBySession`, 不在条目自身复制占用戳.
 */
export interface PendingQueuedInput extends Omit<QueuedSessionInput, 'delivery'> {
  delivery: QueueMessageDelivery;
}

/**
 * 进程内待单次交付的后台完成通知.
 * `key` 按来源和执行 ID 去重, 完整结果仍留在 Subagent SQL 和后台进程日志中.
 */
export type PendingCompletionNotice =
  | {
      readonly key: string;
      readonly source: 'subagent_completed';
      readonly subagentId: string;
      readonly status: Exclude<SubagentStatus, 'running'>;
    }
  | {
      readonly key: string;
      readonly source: 'background_process_completed';
      readonly backgroundProcessId: string;
      readonly status: BackgroundProcessNotifiableStatus;
    };

/** 运行中 Turn 内发生的活跃 Goal 编辑记录, 待下一个安全迭代边界交付给模型. */
export interface PendingGoalEdit {
  readonly turnId: string;
  readonly goalId: string;
  readonly version: number;
}

/**
 * 某次 Turn 在某个 Session 上持有的唯一未确认消息预留, 直到 `confirmMessageSaved` 或 `releaseReservedMessage`.
 * 以 `sessionId` 集中登记当前唯一预留, 无需在每条排队输入或通知上维护 `claimedByTurnId`.
 */
export type MessageReservation =
  | {
      readonly turnId: string;
      readonly sourceType: 'user_inputs';
      readonly queuedInputIds: ReadonlySet<string>;
    }
  | {
      readonly turnId: string;
      readonly sourceType: 'completion_notices';
      readonly completionNoticeKeys: ReadonlySet<string>;
    }
  | {
      readonly turnId: string;
      readonly sourceType: 'goal_edit';
      readonly goalId: string;
      readonly version: number;
    };
