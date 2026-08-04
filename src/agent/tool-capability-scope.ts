// 维护单个 Agent 在当前 Turn 内能看到和执行的工具集合。
import type {
  Tool,
  ToolCapabilityScope,
  ToolCapabilityRestriction,
  ToolCapabilitySnapshot,
  ToolPool,
} from '@ema-agent/tools';
import { ToolPool as FrozenToolPool } from '@ema-agent/tools';

// ToolPool 是异构工具的唯一擦除边界，能力作用域只按稳定 ID 做集合收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/** Skill 或运行模式声明了不存在的工具模式时抛出，避免配置错误静默生效。 */
export class ToolCapabilityRestrictionError extends Error {
  constructor(
    public readonly source: string,
    public readonly unmatchedPatterns: readonly string[],
  ) {
    super(
      `Tool capability restriction "${source}" contains unmatched patterns: ` +
      unmatchedPatterns.join(', '),
    );
    this.name = 'ToolCapabilityRestrictionError';
  }
}

/**
 * 能力作用域只允许做集合交集。它不负责权限审批，也不会在限制移除后自动扩权。
 * ToolPool 中的模式在应用时解析成稳定工具 ID，后续判断不依赖展示名称变化。
 */
export class AgentToolCapabilityScope implements ToolCapabilityScope {
  private readonly rootPool: ToolPool;
  private readonly tools: readonly AnyTool[];
  private readonly toolsByName: ReadonlyMap<string, AnyTool>;
  private allowedIds: Set<string>;
  private readonly restrictionSources: string[] = [];

  constructor(rootPool: ToolPool) {
    // 根 Pool 已经拥有最终 Provider 顺序。Skill 只能做集合交集，不能重新排序并
    // 打散 Builtin/MCP 的稳定分区。
    this.rootPool = rootPool;
    this.tools = rootPool.tools;
    this.toolsByName = new Map(this.tools.map(tool => [tool.name, tool]));
    this.allowedIds = new Set(this.tools.map(tool => tool.id));
  }

  /** 当前作用域内的工具，顺序固定以保持 Provider KV Cache 稳定。 */
  list(): readonly AnyTool[] {
    return this.tools.filter(tool => this.allowedIds.has(tool.id));
  }

  /** 当前 Agent 下一轮模型请求与执行器共同使用的冻结 ToolPool。 */
  pool(): ToolPool {
    if (this.allowedIds.size === this.rootPool.tools.length) return this.rootPool;
    return new FrozenToolPool(this.list());
  }

  allows(toolName: string): boolean {
    const tool = this.toolsByName.get(toolName);
    return tool !== undefined && this.allowedIds.has(tool.id);
  }

  restrict(restriction: ToolCapabilityRestriction): ToolCapabilitySnapshot {
    const patterns = normalizePatterns(restriction.allowedToolPatterns);
    if (patterns.length === 0) return this.snapshot();

    const matchedIds = new Set<string>();
    const unmatchedPatterns: string[] = [];

    for (const pattern of patterns) {
      const matches = this.tools.filter(tool =>
        matchesToolPattern(pattern, tool.name) || matchesToolPattern(pattern, tool.id),
      );
      if (matches.length === 0) {
        unmatchedPatterns.push(pattern);
        continue;
      }
      for (const tool of matches) matchedIds.add(tool.id);
    }

    if (unmatchedPatterns.length > 0) {
      throw new ToolCapabilityRestrictionError(restriction.source, unmatchedPatterns);
    }

    this.allowedIds = new Set(
      [...this.allowedIds].filter(toolId => matchedIds.has(toolId)),
    );
    this.restrictionSources.push(restriction.source);
    return this.snapshot();
  }

  snapshot(): ToolCapabilitySnapshot {
    return Object.freeze({
      allowedToolNames: Object.freeze(this.list().map(tool => tool.name)),
      restrictionSources: Object.freeze([...this.restrictionSources]),
    });
  }
}

function normalizePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))];
}

function matchesToolPattern(pattern: string, candidate: string): boolean {
  const expression = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return escapeRegularExpression(character);
    })
    .join('');
  return new RegExp(`^${expression}$`, 'u').test(candidate);
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
