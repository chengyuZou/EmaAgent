// 按 BuiltinToolContext 能力装配本轮可见工具，替代旧的 scope 运行时筛选。
import type { BuiltTool, ToolRegistry } from '@ema-agent/tools';
import type { BuiltinToolContext } from './builtinToolContext.js';

/**
 * 从 registry 中筛出 requires 声明的能力在 hostContext 中全部存在的工具。
 *
 * - 无 requires 的工具（无状态或带 CLI 兜底）总是可见。
 * - 有 requires 的工具：任一声明能力在 hostContext 中为 null/undefined 即隐藏，
 *   模型看不到它无法调用的工具。
 *
 * 返回值供 ToolRegistry.manifestSnapshot() 生成模型可见清单。
 * 实际执行时的窄 Context 投影由 ToolExecutionRuntime 调 validateContext 完成，
 * 与此处可见性筛选是两条独立链路（可见性=装配期静态声明，投影=执行期动态取值）。
 */
export function assembleToolPool(
  registry: ToolRegistry,
  hostContext: BuiltinToolContext,
  selection?: readonly BuiltTool[],
): BuiltTool[] {
  const candidates = selection ?? registry.list();
  return candidates.filter((tool) => {
    const required = tool.requires;
    if (!required || required.length === 0) return true;
    for (const key of required) {
      const capability = hostContext[key as keyof BuiltinToolContext];
      if (capability == null || capability === '') return false;
    }
    return true;
  });
}
