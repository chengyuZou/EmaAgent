// 提供 UI 边界使用的有限数值回退与区间限制函数。
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function clampFinite(
  value: number,
  minimum: number,
  maximum: number,
  fallback = minimum,
): number {
  const safeMinimum = finiteOr(minimum, 0);
  const safeMaximum = Math.max(safeMinimum, finiteOr(maximum, safeMinimum));
  const safeFallback = Math.min(
    safeMaximum,
    Math.max(safeMinimum, finiteOr(fallback, safeMinimum)),
  );
  const safeValue = finiteOr(value, safeFallback);
  return Math.min(safeMaximum, Math.max(safeMinimum, safeValue));
}
