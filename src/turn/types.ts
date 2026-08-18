// TurnExecutor 公开入口的启动输入、唯一终态与运行句柄；领域词汇本体在 @ema-agent/turn-terms。
import type { ContentPart } from '@ema-agent/llm';
import type {
  ExecutionProfile,
  NarrativePolicy,
  TurnFailureCode,
  TurnStats,
  TurnTriggerType,
} from '@ema-agent/turn-terms';
import type { TurnAttachmentInput } from '@ema-agent/attachments';
import type { TurnStreamEvent } from './events.js';

/**
 * 启动一个根 Turn 的判别输入。Command/Skill 解析已在调用方完成，
 * Turn 不再解析 '/' 语法，也不接受 prepare 回调——准备工作收归 Turn 内部。
 */
export interface StartTurn {
  /** 内部恢复流程可预留稳定身份；公开请求始终由 TurnStore 生成。 */
  readonly turnId?: string;
  readonly sessionId: string;
  readonly triggerType: TurnTriggerType;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  /** 用户消息原始文本；与 contentParts/attachments 至少其一非空。 */
  readonly userInput?: string;
  readonly contentParts?: readonly ContentPart[];
  readonly attachments?: readonly TurnAttachmentInput[];
  /** 本次覆盖 Session 默认的模型选择；省略时按 Session 偏好与业务绑定解析。 */
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinkingEnabled?: boolean;
  /** 本 Turn 检索范围限定；省略时按当前激活知识库。 */
  readonly kbId?: string;
  readonly kbAssetIds?: readonly string[];
  /** 本轮显式选择的 Skill；正文在准备阶段冻结，同一 Turn 全部 LlmCall 字节稳定。 */
  readonly selectedSkillKeys?: readonly string[];
}

/** Turn 对外只有一个明确终态，完成 Promise 与终态事件使用同一份数据。 */
export type TurnOutcome =
  | {
      readonly status: 'completed';
      readonly sessionId: string;
      readonly turnId: string;
      readonly stats: TurnStats;
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
