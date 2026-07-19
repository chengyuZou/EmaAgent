// 根据模型未缩放边界计算 Live2D 在当前舞台中的绝对缩放与位置。
import type { Live2DFraming } from './types.js';

export interface Live2DNaturalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Live2DViewport {
  width: number;
  height: number;
}

export interface Live2DFramingPlacement {
  scale: number;
  x: number;
  y: number;
}

export function calculateLive2DFraming(
  viewport: Live2DViewport,
  naturalBounds: Live2DNaturalBounds,
  framing: Live2DFraming,
): Live2DFramingPlacement | null {
  if (
    !isPositiveFinite(viewport.width)
    || !isPositiveFinite(viewport.height)
    || !isPositiveFinite(naturalBounds.width)
    || !isPositiveFinite(naturalBounds.height)
    || !Number.isFinite(naturalBounds.x)
    || !Number.isFinite(naturalBounds.y)
  ) {
    return null;
  }

  const scale = framing === 'halfbody'
    ? (viewport.width / naturalBounds.width) * 1.55
    : Math.min(
      viewport.width / naturalBounds.width,
      viewport.height / naturalBounds.height,
    ) * 0.95;

  const scaledWidth = naturalBounds.width * scale;
  const scaledHeight = naturalBounds.height * scale;
  const x = (viewport.width - scaledWidth) / 2 - naturalBounds.x * scale;
  const y = framing === 'halfbody'
    ? -scaledHeight * 0.05 - naturalBounds.y * scale
    : viewport.height - scaledHeight - 12 - naturalBounds.y * scale;

  return { scale, x, y };
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
