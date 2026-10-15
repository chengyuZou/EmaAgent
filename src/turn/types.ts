import type { TurnStatus } from '@ema-agent/session';
import type { AttachmentBlock } from '@ema-agent/session';
import type { TurnFailureCode } from './errors.js';
import type { TurnStreamEvent } from './events.js';

/**
 * userMessage 来自用户主动输入, sessionContinuation 承载内部完成通知或 Goal 续接.
 */
export type TurnTriggerType = 'userMessage' | 'sessionContinuation';

export interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly status: TurnStatus;
  readonly triggerType: TurnTriggerType;
  /** 本 Turn 启动时冻结的语音选择. 与之后可修改的 Session 偏好不同. */
  readonly ttsEnabled: boolean;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** 选择provider-model 的协议 */
  readonly protocol: string | null;
  /**
   * 本轮参与对话的角色的稳定 Character.name, 在 Prepare 完成时记录.
   * 后续切换角色或选择其他角色朗读不改变它; 尚未记录角色身份时为 null.
   */
  readonly characterName: string | null;
  readonly iterations: number;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface StartTurnInput {
  /** 队列预先分配执行身份; 直接创建记录时可由 Store 生成. */
  readonly turnId?: string;
  readonly sessionId: string;
  readonly triggerType: TurnTriggerType;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly ttsEnabled: boolean;
}

// ── Turn 导航查询的输入输出（TurnStore 的读取面） ─────────────────────────────

export interface ListTurnIndexInput {
  /** 上一页返回的不透明游标，只能原样回传。 */
  cursor?: string;
  limit?: number;
}

export interface TurnIndexItem {
  turnId: string;
  /** 本 Turn 第一条可展示 Message，供 History 导航直接定位正文。 */
  anchorMessageId: string;
  createdAt: number;
  completedAt: number | null;
  status: TurnStatus;
  triggerType: TurnTriggerType;
  /** 首条 User Message 的正文预览；用户输入的唯一事实源是 Message。 */
  preview: string;
}

export interface TurnIndexPage {
  items: TurnIndexItem[];
  nextCursor?: string;
}

// ── 请求在调用 Provider 前执行的可观测兼容降级（词汇，非事件） ────────────────

export interface RequestDegradationNotice {
  attempt: number;
  reason: string;
  removed: Array<'image' | 'audio' | 'file' | 'parameter'>;
  replacements: Array<'description' | 'placeholder' | 'parameter_omitted'>;
}

// Turn 失败终态的错误码/阶段定义归 errors.ts（错误语义）；此处只消费。

/** 用户消息的唯一有序输入；数组顺序就是持久化、模型读取和历史展示顺序。 */
export type TurnInputPart =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'attachment';
      readonly block: AttachmentBlock;
    }
  | {
      readonly type: 'skill_reference';
      readonly name: string;
      readonly path: string;
    };

/** 空白文本不是输入；附件或 Skill 引用本身就是有效输入。 */
export function hasTurnInput(input: readonly TurnInputPart[]): boolean {
  return input.some(part => part.type !== 'text' || part.text.trim().length > 0);
}

/**
 * 队列启动一次 Turn 时交付的输入. Command/Skill 解析由调用方完成,
 * Turn 不解析 '/' 语法, 负责准备模型和工具并执行本轮.
 */
export interface StartTurn {
  /** 队列在领取输入时分配, 用于确认哪些输入已经保存. */
  readonly turnId?: string;
  readonly sessionId: string;
  readonly triggerType: TurnTriggerType;
  readonly input: readonly TurnInputPart[];
  /** 队列交付的内部通知或继续指令, 持久化为 kind='continuation' 的 Message. */
  readonly continuationText?: string;
  readonly ttsEnabled: boolean;
}

/** Turn 对外只有一个明确终态，完成 Promise 与终态事件使用同一份数据。 */
export type TurnOutcome =
  | {
      readonly status: 'completed';
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly status: 'failed';
      readonly sessionId: string;
      readonly turnId: string;
      readonly code: TurnFailureCode;
      readonly message: string;
    }
  | {
      readonly status: 'aborted';
      readonly sessionId: string;
      readonly turnId: string;
      readonly reason: string;
    };

/** Turn 的运行句柄. 事件流只允许一个消费者; 重复消费会明确失败. */
export interface TurnHandle {
  readonly sessionId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<TurnStreamEvent>;
  readonly completion: Promise<TurnOutcome>;
  abort(): void;
}
