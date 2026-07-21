export type PromptSlotId =
  | 'product.rules'
  | 'product.toolGuidance'
  | 'character.identity'
  | 'character.presentation'
  | 'profile.execution';

export type PromptSlotKind =
  | 'rules'
  | 'guidance'
  | 'identity'
  | 'presentation'
  | 'execution';

export type PromptCacheScope = 'global' | 'session' | 'turn';

/**
 * product 由应用内置；user-configured 由用户选择的角色或设置提供；
 * extension 留给显式启用的 Skill/MCP 指令，不代表它可以绕过 Permission。
 */
export type PromptTrust = 'product' | 'user-configured' | 'extension';

/** 业务模块只能贡献正文和版本，不能自行选择指令位置或信任级别。 */
export interface PromptSlotContribution {
  readonly id: PromptSlotId;
  readonly content: string;
  readonly version: string;
}

export interface PromptSlot {
  readonly id: PromptSlotId;
  readonly kind: PromptSlotKind;
  readonly order: number;
  readonly content: string;
  readonly version: string;
  readonly cacheScope: PromptCacheScope;
  readonly trust: PromptTrust;
}

export interface PromptSnapshot {
  readonly slots: readonly PromptSlot[];
  readonly revision: string;
  readonly systemText: string;
}
