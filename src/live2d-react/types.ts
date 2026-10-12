export interface Live2DStageReadyInfo {
  hasExpressions: boolean;
  expressions: readonly string[];
}

export interface Live2DStageHandle {
  setExpression(name: string | null): void;
  setPlacement(stageScale: number, stageOffsetX: number, stageOffsetY: number): void;
  playMotion(group: string, index: number): void;
  setLipSync(speaking: boolean, mouthOpen: number): void;
  /** 鼠标相对窗口内容区的位置, 单位为页面逻辑像素, 允许位于窗口外. */
  setPointerPosition(clientX: number, clientY: number): void;
}
