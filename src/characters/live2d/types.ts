/**
 * 某个角色的单个Live2D模型
 * @param name 模型名 唯一标识符 落盘时作为目录名使用且不允许修改
 * @param characterName 模型所属的角色标识符 对应为 Character.name
 * @param displayName 模型的显示名称
 * @param stageScale 主窗口中的缩放倍率 1 表示模型原始显示大小 有效范围为 0.1～5
 * @param stageOffsetX 相对舞台中心的水平偏移 -1 为最左侧 0 为居中 1 为最右侧
 * @param stageOffsetY 相对舞台中心的垂直偏移 -1 为最上方 0 为居中 1 为最下方
 * @param isPrimary 是否为角色的主要Live2D模型 主要模型会在角色首次登场时使用
 */
export interface CharacterLive2dModel {
  name: string;
  characterName: string;
  displayName: string;
  stageScale: number;
  stageOffsetX: number;
  stageOffsetY: number;
  isPrimary: boolean;
  byteSize: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dModelInput {
  name: string;
  displayName: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  isPrimary?: boolean;
  byteSize?: number | null;
}

export interface CharacterLive2dModelPatch {
  displayName?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
}

export interface ImportCharacterLive2dModelInput {
  source: string;
  isPrimary?: boolean;
}

/** 语义情绪名到模型原生 Expression 的映射。 */
export interface Live2dExpression {
  expression: string;
}

/** 指向 `.model3.json` 中真实存在的一个 Motion。 */
export interface Live2dMotion {
  group: string;
  /** 省略时由渲染层在组内选择。 */
  index?: number;
}

/**
 * Live2D 模型的运行时配置
 * Live2D 有 .expression3.json/ .exp.json  .motion3.json 等配置文件用于描述模型的表情和动作
 * 但这些配置文件的内容是模型原生的 无法直接用于运行时控制
 * 因此需要在这里提供一个映射关系 将语义化的标签映射到模型原生的表情和动作上
 * 形成类似于 "sad" : { expression: "sad" } 的映射关系
 * 以便于通过LLM生成的<emotion> <motion>等标签来控制运行时Live2D模型的表情和动作
 */
export interface Live2dRuntimeConfig {
  emotionMap?: Record<string, Live2dExpression>;
  motionMap?: Record<string, Live2dMotion>;
  idleMotions?: Live2dMotion[];
  lipSyncParameterIds?: string[];
}

export interface Live2dNativeMotion {
  readonly group: string;
  readonly index: number;
}

export interface Live2dConfiguration {
  readonly runtimeConfig: Live2dRuntimeConfig;
  readonly expressions: readonly string[];
  readonly motions: readonly Live2dNativeMotion[];
}

export interface Live2dMappings {
  readonly emotionMap: Readonly<Record<string, { readonly expression: string }>>;
  readonly motionMap: Readonly<Record<string, Live2dMotion>>;
}
