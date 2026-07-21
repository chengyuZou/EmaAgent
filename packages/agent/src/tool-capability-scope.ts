// 这里维护单个 Agent 在当前 Turn 内能看到和执行的工具集合。
import type {
  IToolCapabilityScope,
  ToolCapabilityRestriction,
  ToolCapabilitySnapshot,
  ToolManifestEntry,
} from '@ema-agent/tools';

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
 * Manifest 中的模式在应用时解析成稳定工具 ID，后续判断不依赖展示名称变化。
 */
export class AgentToolCapabilityScope implements IToolCapabilityScope {
  private readonly tools: readonly ToolManifestEntry[];
  private readonly toolsByName: ReadonlyMap<string, ToolManifestEntry>;
  private allowedIds: Set<string>;
  private readonly restrictionSources: string[] = [];

  constructor(allTools: readonly ToolManifestEntry[]) {
    this.tools = Object.freeze(
      [...allTools].sort((left, right) => compareToolNames(left.name, right.name)),
    );
    this.toolsByName = new Map(this.tools.map(tool => [tool.name, tool]));
    this.allowedIds = new Set(this.tools.map(tool => tool.id));
  }

  /** 当前作用域内的工具，顺序固定以保持 Provider KV Cache 稳定。 */
  list(): readonly ToolManifestEntry[] {
    return this.tools.filter(tool => this.allowedIds.has(tool.id));
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

function compareToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
