// 定义 Live2D 舞台对宿主公开的命令与就绪信息。

export interface Live2DStageReadyInfo {
  /** 宿主用它决定是否展示表情操作。 */
  hasExpressions: boolean;
  /** 当前 model3.json 正式登记的 Expression 名称。 */
  expressions: readonly string[];
}

/** 宿主通过同一句柄驱动当前已就绪的模型实例。 */
export interface Live2DStageHandle {
  setExpression(name: string | null): void;
  setPlacement(stageScale: number, stageOffsetX: number, stageOffsetY: number): void;
  playMotion(group: string, index: number): void;
  /** `mouthOpen` 是由 Speech/宿主换算好的 0..1 归一化开口度。 */
  setLipSync(speaking: boolean, mouthOpen: number): void;
}
