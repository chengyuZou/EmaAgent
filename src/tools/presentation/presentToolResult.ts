// 将模型结果与只供客户端展示的结构化 Presentation 关联，并在执行边界拆开。
import type { ToolPresentation } from './toolPresentation.js';

const presentations = new WeakMap<object, ToolPresentation>();

export interface SplitToolResult {
  modelOutput: unknown;
  presentation?: ToolPresentation;
}

export function presentToolResult<T extends object>(
  modelOutput: T,
  presentation: ToolPresentation,
): T {
  presentations.set(modelOutput, presentation);
  return modelOutput;
}

export function splitToolResult(value: unknown): SplitToolResult {
  if (typeof value === 'object' && value !== null) {
    const presentation = presentations.get(value);
    if (presentation) {
      presentations.delete(value);
      return { modelOutput: value, presentation };
    }
  }
  return { modelOutput: value };
}
