export interface CharacterLive2dModel {
  id: string;
  characterId: string;
  name: string;
  /** 创建时确定、此后不可修改的磁盘目录名。 */
  directoryName: string;
  /** 从该资源 runtime-config.json 提取的派生词汇。 */
  emotionVocabulary: string[];
  motionVocabulary: string[];
  /** 主窗口中的缩放倍率；1 表示模型原始显示大小，有效范围为 0.1～5。 */
  stageScale: number;
  /** 相对舞台中心的水平偏移；-1 为最左侧，0 为居中，1 为最右侧。 */
  stageOffsetX: number;
  /** 相对舞台中心的垂直偏移；-1 为最上方，0 为居中，1 为最下方。 */
  stageOffsetY: number;
  isPrimary: boolean;
  enabled: boolean;
  byteSize: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dModelInput {
  id?: string;
  name: string;
  directoryName: string;
  /** 主窗口中的缩放倍率；不传时使用 1。 */
  stageScale?: number;
  /** 相对舞台中心的水平偏移；有效范围为 -1～1。 */
  stageOffsetX?: number;
  /** 相对舞台中心的垂直偏移；有效范围为 -1～1。 */
  stageOffsetY?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize?: number | null;
}

export interface CharacterLive2dModelPatch {
  name?: string;
  /** 主窗口中的缩放倍率；有效范围为 0.1～5。 */
  stageScale?: number;
  /** 相对舞台中心的水平偏移；有效范围为 -1～1。 */
  stageOffsetX?: number;
  /** 相对舞台中心的垂直偏移；有效范围为 -1～1。 */
  stageOffsetY?: number;
  enabled?: boolean;
}

export interface ImportCharacterLive2dModelInput {
  sourceZipFile: string;
  isPrimary?: boolean;
}

/** 语义情绪名到模型原生 Expression 的映射；空对象 = 作者明确置空（不进词汇不渲染）。 */
export interface Live2dExpression {
  expression?: string;
}

/** 指向 `.model3.json` 中真实存在的一个 Motion。 */
export interface Live2dMotion {
  group: string;
  /** 省略时由渲染层在组内选择。 */
  index?: number;
}

/**
 * runtime-config.json 的权威形状：语义名到模型原生素材的单股映射——
 * 情绪只映射 Expression、动作只映射 Motion，两个映射的键不允许重名。
 * 位置与解析归 Character 拥有，主窗口经 presentation 快照消费，不自行定位文件。
 */
export interface Live2dRuntimeConfig {
  emotionMap?: Record<string, Live2dExpression>;
  motionMap?: Record<string, Live2dMotion>;
  idleMotions?: Live2dMotion[];
  lipSyncParameterIds?: string[];
}
