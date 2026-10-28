import type { SubagentStatus } from '@ema-agent/agent';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import type { TurnInputPart } from '../types.js';

/** 已提交但尚未写入 Message 的正文或附件, 包括自动截图. 只保存在当前进程内存中. */
export interface EnqueueSessionInput {
  readonly sessionId: string;
  readonly input: readonly TurnInputPart[];
}

/**
 * 前端队列卡片和 WebSocket 事件共用的公开投影.
 * after_turn 等 Session 空闲后启动 Turn, 包括等待手动压缩完成.
 * next_iteration 在 AgentLoop 的安全迭代边界注入; 本轮已结束则随下一 Turn 交付.
 */
export interface QueuedSessionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly input: readonly TurnInputPart[];
  readonly createdAt: number;
  readonly delivery: 'after_turn' | 'next_iteration';
}

/**
 * Session WebSocket 的队列增量协议. 连接时的当前列表随 session_state 发送,
 * 正式保存时由 user_message_stored 通知消费的输入 ID, 返回草稿则携带原输入.
 */
export type SessionContinuationEvent =
  | { readonly type: 'queued_input_added'; readonly item: QueuedSessionInput }
  | { readonly type: 'queued_input_removed'; readonly id: string }
  | { readonly type: 'queued_input_guided'; readonly item: QueuedSessionInput }
  | { readonly type: 'queued_inputs_returned'; readonly items: readonly QueuedSessionInput[] };

/**
 * Turn 从队列临时领取的内容. 领取不等于消费: 调用方写完 Message 后必须 acknowledge,
 * 准备或写库失败则必须 release, 这样输入和后台通知才不会静默丢失.
 */
export type ClaimedSessionContinuation =
  | {
      // 正文和附件输入. 自动截图也从这里交付.
      readonly inputKind: 'messageInput';
      readonly input: readonly TurnInputPart[];
      // 新 Turn 同时需要继续当前 Goal 时, 附带这段内部提醒.
      readonly continuationText?: string;
    }
  | {
      // 子代理或后台命令完成通知, Goal 修改提醒或继续目标的指令. Turn 保存后再交给模型.
      readonly inputKind: 'continuationText';
      readonly continuationText: string;
    };

/** 已领取的输入不能再删除, 改为引导或被其它 Turn 领取. */
export interface PendingInput extends Omit<QueuedSessionInput, 'delivery'> {
  delivery: QueuedSessionInput['delivery'];
  claimedByTurnId?: string;
}

/**
 * 后台完成通知只携带执行身份和终态, 不复制完整输出.
 * 分为子代理和后台Process两类, 但都只在当前进程内投递一次.
 * key 统一两类执行的去重身份; 完整结果分别留在 Subagent SQL 和后台进程日志中.
 */
export type CompletionNotice =
  | {
      readonly key: string;
      readonly kind: 'subagent';
      readonly id: string;
      readonly status: Exclude<SubagentStatus, 'running'>;
      claimedByTurnId?: string;
    }
  | {
      readonly key: string;
      readonly kind: 'background_process';
      readonly id: string;
      readonly status: BackgroundProcessNotifiableStatus;
      claimedByTurnId?: string;
    };

/**
 * 队列记录一次领取占用了哪些输入或通知, 供 acknowledge 删除或 release 归还.
 * 这是消费记录, 与交给 Turn 的 ClaimedSessionContinuation 内容不同.
 * 新 Turn 的 Goal 续接每次读取当前目标后生成, 不占用一次性队列项.
 */
export type ContinuationClaim =
  | {
      readonly type: 'user_input';
      readonly sessionId: string;
      readonly userInputIds: readonly string[];
    }
  | {
      readonly type: 'completion_notices';
      readonly sessionId: string;
      readonly completionNoticeKeys: readonly string[];
    }
  | {
      readonly type: 'goal_edit';
      readonly sessionId: string;
      readonly goalId: string;
      readonly version: number;
    };

