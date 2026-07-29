// 把一次 Turn 的工具能力作用域转换成模型工具定义和执行准入判断。
import type {
  ToolCapabilityScope,
  ToolManifestSnapshot,
} from '@ema-agent/tools';
import { createToolManifestSnapshotFromEntries } from '@ema-agent/tools';
import type { LlmToolDef } from '@ema-agent/llm';
import { AgentToolCapabilityScope } from './tool-capability-scope.js';

// ── TurnPolicy ────────────────────────────────────────────────────────────────

export class TurnPolicy {
  private readonly scope: AgentToolCapabilityScope;

  constructor(
    private readonly manifest: ToolManifestSnapshot,
    private readonly maxIter = 30,
  ) {
    this.scope = new AgentToolCapabilityScope(manifest.entries);
  }

  /** LlmToolDef[] ready to pass straight to LlmRequest.tools. */
  toolDefs(): LlmToolDef[] {
    return this.scope.list().map((t) => {
      return {
        name: t.name,
        description: t.description,
        parameters: t.inputJsonSchema as Record<string, unknown>,
      };
    });
  }

  /** Returns true if the named tool is permitted under this policy. */
  allows(toolName: string): boolean {
    return this.scope.allows(toolName);
  }

  /** 交给 BuiltinToolContext.toolCapabilities，使 Skill 和未来运行模式只能收窄能力。 */
  capabilities(): ToolCapabilityScope {
    return this.scope;
  }

  /**
   * 子 Agent 在真正 spawn 时读取当前上限；返回副本，调用方不能改写父作用域。
   * Skill 若已收窄当前 Agent，这里会立即反映收窄后的稳定工具 ID。
   */
  allowedIds(): ReadonlySet<string> {
    return new Set(this.scope.list().map((tool) => tool.id));
  }

  manifestSnapshot(): ToolManifestSnapshot {
    return this.manifest;
  }

  /** Skill 等能力收窄后的模型可见清单，执行仍受原 Manifest 与 allows 双重约束。 */
  visibleManifestSnapshot(): ToolManifestSnapshot {
    return createToolManifestSnapshotFromEntries(
      this.scope.list(),
      this.manifest.registryVersion,
    );
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
