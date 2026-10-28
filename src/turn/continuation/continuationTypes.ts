import type { SubagentStatus } from '@ema-agent/agent';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import type { TurnInputPart } from '../types.js';

/** 已提交但尚未写入 Message 的用户输入, 只保存在当前进程内存中. */
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
      readonly type: 'user_input';
      readonly input: readonly TurnInputPart[];
      readonly continuationText?: string;
    }
  | {
      readonly type: 'continuation';
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

/** 一次领取的反向索引. 一次性输入, 通知和目标编辑需要确认; after-turn Goal 提示不消耗队列项. */
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

