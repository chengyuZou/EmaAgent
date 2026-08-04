// 保存一个根 Turn 冻结的有序 Tool 对象集合，供模型投影与执行查找共同使用。
import type { Tool } from '../Tool/tool.js';

// ToolPool 是 Tool 泛型的统一擦除边界，具体类型在单次 ToolExecution 中恢复。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/**
 * 根 Turn 的唯一工具事实源。
 *
 * tools 保留稳定顺序；get() 返回同一个 Tool 对象。Pool 不复制 Schema、说明、
 * 来源或执行函数，也不会在 MCP Registry 更新后自行变化。
 */
export class ToolPool {
  readonly tools: readonly AnyTool[];
  private readonly toolsByName: ReadonlyMap<string, AnyTool>;

  constructor(tools: readonly AnyTool[]) {
    this.tools = Object.freeze([...tools]);
    this.toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));
    Object.freeze(this);
  }

  get(name: string): AnyTool | undefined {
    return this.toolsByName.get(name);
  }

  /**
   * 从父 Pool 派生顺序不变的更窄 Pool。
   *
   * Skill、执行 Profile 和子 Agent 只能调用该方法做集合收窄；它不会回读全局
   * Registry，因此不能把根 Turn 启动后才出现的工具扩进来。
   */
  filter(predicate: (tool: AnyTool) => boolean): ToolPool {
    return new ToolPool(this.tools.filter(predicate));
  }
}
