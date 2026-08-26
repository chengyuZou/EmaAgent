// 定义 Live2D 舞台对宿主公开的资源绑定、命令与就绪信息。

/** 指向 `.model3.json` 中真实存在的一个 Motion。 */
export interface Live2DMotionReference {
  group: string;
  /** 省略时由 Cubism MotionManager 在组内选择。 */
  index?: number;
}

/** Character 为当前 Live2D 资源明确选定的播放绑定。 */
export interface Live2DModelBindings {
  /** 只有这里列出的 Motion 才会被自动待机调度。 */
  idleMotions?: readonly Live2DMotionReference[];
  /** `undefined` 使用模型 LipSync group；空数组明确关闭口型。 */
  lipSyncParameterIds?: readonly string[];
}

export interface Live2DStageReadyInfo {
  /** 宿主用它决定是否展示表情操作。 */
  hasExpressions: boolean;
}

/** 宿主通过同一句柄驱动当前已就绪的模型实例。 */
export interface Live2DStageHandle {
  setExpression(name: string | null): void;
  cycleExpression(): string | null;
  playMotion(group: string, index?: number): void;
  /** `mouthOpen` 是由 Speech/宿主换算好的 0..1 归一化开口度。 */
  setLipSync(speaking: boolean, mouthOpen: number): void;
}
