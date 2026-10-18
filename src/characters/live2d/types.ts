
export interface CharacterLive2dModel {
  name: string;
  characterName: string;
  displayName: string;
  /** 对默认构图的缩放倍率, 范围 0.1 到 5. */
  stageScale: number;
  /** 相对舞台宽度的水平偏移比例, 范围 -1 到 1. */
  stageOffsetX: number;
  /** 相对舞台高度的垂直偏移比例, 范围 -1 到 1. */
  stageOffsetY: number;
  isPrimary: boolean;
  /** null 表示尚未取得资源目录的总字节数. */
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

export interface PrepareCharacterLive2dImportInput {
  source: string;
}

export interface PreparedLive2dImport {
  importId: string;
  name: string;
  displayName: string;
  byteSize: number;
}

/** 语义情绪名到模型原生 Expression 的映射. */
export interface Live2dExpression {
  expression: string;
}

/** 指向 `.model3.json` 中真实存在的一个 Motion. */
export interface Live2dMotion {
  group: string;
  index: number;
}

/** 把 LLM 标签中的情绪和动作名称映射到 .model3.json 登记的 Expression 和 Motion. */
export interface Live2dRuntimeConfig {
  emotionMap?: Record<string, Live2dExpression>;
  motionMap?: Record<string, Live2dMotion>;
}

export interface Live2dNativeMotion {
  readonly group: string;
  readonly index: number;
  readonly file: string;
}

export interface Live2dNativeExpression {
  readonly expression: string;
  readonly file: string;
}

export interface Live2dConfiguration {
  readonly runtimeConfig: Live2dRuntimeConfig;
  readonly expressions: readonly Live2dNativeExpression[];
  readonly motions: readonly Live2dNativeMotion[];
  readonly unregisteredExpressionFiles: readonly string[];
  readonly unregisteredMotionFiles: readonly string[];
}

export interface Live2dMappings {
  readonly emotionMap: Readonly<Record<string, { readonly expression: string }>>;
  readonly motionMap: Readonly<Record<string, Live2dMotion>>;
}
