import type { CharacterCard } from '@ema-agent/characters';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';

export type PromptSlotId =
  | 'product.rules'
  | 'product.toolGuidance'
  | 'extension.skillCatalog'
  | 'workspace.instructions'
  | 'character.identity'
  | 'character.presentation'
  | 'profile.execution'
  | `skills.required.${string}`
  | `skills.active.${string}`;

/**
 * 描述内容何时可能变化，不描述数据存放位置。
 * product 全应用稳定;activeCharacter 随角色切换;session 随工作区会话(跨 Turn 复用);turn 按根 Turn 冻结。
 */
export type PromptStabilityScope = 'product' | 'activeCharacter' | 'session' | 'turn';

/** 外部扩展目录作为模型上下文投递，不能获得产品 System 指令权限。 */
export type PromptDelivery = 'system' | 'context';

/** 业务模块只能贡献正文和版本，不能自行选择指令位置或信任级别。 */
export interface PromptSlotContribution {
  readonly id: PromptSlotId;
  readonly content: string;
  readonly version: string;
}

export interface PromptSlot {
  readonly id: PromptSlotId;
  readonly order: number;
  readonly content: string;
  readonly version: string;
  readonly stabilityScope: PromptStabilityScope;
  readonly delivery: PromptDelivery;
}

/** 同一稳定范围内的 Slot 合并为一块，协议层可以保留真实缓存断点。 */
export interface PromptBlock {
  readonly stabilityScope: PromptStabilityScope;
  readonly delivery: PromptDelivery;
  readonly content: string;
  readonly revision: string;
  readonly cacheBreakpoint: boolean;
}

export interface PromptRevisions {
  readonly product: string;
  readonly activeCharacter: string;
  readonly turn: string;
  readonly complete: string;
}

export interface PromptSnapshot {
  readonly slots: readonly PromptSlot[];
  readonly systemBlocks: readonly PromptBlock[];
  readonly contextBlocks: readonly PromptBlock[];
  readonly revisions: PromptRevisions;
  readonly revision: string;
}

/** Prompt 只接收稳定行为输入；历史、召回、附件和工作区事实由 Context 处理。 */
export interface PromptBuildRequest {
  /** CharacterCardStore.current() 返回的全局激活角色；不是 Session 角色绑定。 */
  readonly activeCharacter: CharacterCard;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly extensionContributions?: readonly PromptSlotContribution[];
}
