// 把给模型的简短工具结果和只给客户端展示的结构化内容分开。
import type { ToolPresentation } from './presentation/index.js';

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
