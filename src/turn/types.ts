// Turn 领域对象与公开入口契约；共享词汇 SessionMode/NarrativePolicy/TurnStatus 来自 @ema-agent/session。
import type {
  SessionMode,
  NarrativePolicy,
  TurnStatus,
} from '@ema-agent/session';
import type { AttachmentBlock } from '@ema-agent/session';
import type { TurnFailureCode } from './errors.js';
import type { TurnStreamEvent } from './events.js';

/**
 * userMessage 来自用户队列, sessionContinuation 只承载后台终态.
 */
export type TurnTriggerType = 'userMessage' | 'sessionContinuation';

// ── Turn 领域对象（事实源；持久化行见 storage TurnRow，边界显式映射） ──────────

export interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly status: TurnStatus;
  readonly triggerType: TurnTriggerType;
  /** Turn 启动时从 Session 复制的冻结事实。 */
  readonly sessionMode: SessionMode;
  /** Turn 启动时从 Session 复制的冻结事实。 */
  readonly narrativePolicy: NarrativePolicy;
  /** 操作开始冻结的模型选择；prepare 解析成功前为 null。 */
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** prepare 解析出的实际调用协议（与 providerId/modelId 同生命周期，setModel 回填前为 null）。 */
  readonly protocol: string | null;
  /** 本 Turn 激活角色的磁盘目录名快照（Memory relationship 提取的事实源）；prepare 完成回填，此前为 null。 */
  readonly characterDirectoryName: string | null;
  readonly iterations: number;
  /** 创建即启动的唯一时序事实：排序、分页、时长与 fork 截断都用它。 */
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface StartTurnInput {
  /** Session 续接预先分配身份, 普通请求由 Store 生成. */
  readonly turnId?: string;
  readonly sessionId: string;
  readonly triggerType: TurnTriggerType;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly sessionMode: SessionMode;
  readonly narrativePolicy: NarrativePolicy;
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
  sessionMode: SessionMode;
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

/** 本 Turn 在当前激活知识库内的文档范围；不提供 knowledge 表示使用整个激活库。 */
export interface TurnKnowledgeSelection {
  readonly assetIds: readonly string[];
}

/** 空白文本不是输入；附件或 Skill 引用本身就是有效输入。 */
export function hasTurnInput(input: readonly TurnInputPart[]): boolean {
  return input.some(part => part.type !== 'text' || part.text.trim().length > 0);
}

export interface TurnCreatedResponse {
  readonly turnId: string;
  readonly sessionId: string;
}

/**
 * 启动一个根 Turn 的判别输入。Command/Skill 解析已在调用方完成，
 * Turn 不再解析 '/' 语法，也不接受 prepare 回调——准备工作收归 Turn 内部。
 */
export interface StartTurn {
  /** 内部恢复流程可预留稳定身份；公开请求始终由 TurnStore 生成。 */
  readonly turnId?: string;
  readonly sessionId: string;
  readonly triggerType: TurnTriggerType;
  readonly sessionMode: SessionMode;
  readonly narrativePolicy: NarrativePolicy;
  readonly input: readonly TurnInputPart[];
  /** 已完成后台工作的轻量通知. 完整结果由模型按其中的执行 id 主动读取. */
  readonly completionNoticeText?: string;
  readonly knowledge?: TurnKnowledgeSelection;
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

/** 根 Turn 的稳定运行句柄。事件流只允许一个消费者；重复消费会明确失败。 */
export interface TurnHandle {
  readonly sessionId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<TurnStreamEvent>;
  readonly completion: Promise<TurnOutcome>;
  abort(): void;
}
