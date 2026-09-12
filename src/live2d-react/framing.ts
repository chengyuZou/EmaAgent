// 根据模型未缩放边界计算 Live2D 在当前舞台中的默认半身构图。

export interface Live2DModelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Live2DStageSize {
  width: number;
  height: number;
}

export interface Live2DModelPlacement {
  scale: number;
  x: number;
  y: number;
}

export function calculateLive2DPlacement(
  stage: Live2DStageSize,
  model: Live2DModelBounds,
  stageScale = 1,
  stageOffsetX = 0,
  stageOffsetY = 0,
): Live2DModelPlacement | null {
  if (
    !isPositiveFinite(stage.width)
    || !isPositiveFinite(stage.height)
    || !isPositiveFinite(model.width)
    || !isPositiveFinite(model.height)
    || !Number.isFinite(model.x)
    || !Number.isFinite(model.y)
  ) {
    return null;
  }

  const scale = (stage.width / model.width) * 1.55 * stageScale;
  const scaledWidth = model.width * scale;
  const scaledHeight = model.height * scale;

  return {
    scale,
    x: (stage.width - scaledWidth) / 2 - model.x * scale + stage.width * stageOffsetX,
    y: -scaledHeight * 0.05 - model.y * scale + stage.height * stageOffsetY,
  };
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
