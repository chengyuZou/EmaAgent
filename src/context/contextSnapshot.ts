// 定义单次模型调用的不可变 Context 输入、输出与缓存诊断快照。
import type { Message, LlmToolDef } from '@ema-agent/llm';
import type { PromptSnapshot } from '@ema-agent/prompts';
import type { ToolManifestSnapshot } from '@ema-agent/tools';
import type { ContextContribution } from './types.js';

export interface ContextAssemblyInput {
  readonly prompt: PromptSnapshot;
  readonly environment?: RuntimeEnvironmentSnapshot;
  readonly history: readonly Message[];
  /** 当前 Turn 可能已包含多轮 assistant/tool_result，因此不能假设只有一条 user message。 */
  readonly currentTurn: readonly Message[];
  readonly contributions?: readonly ContextContribution[];
  /** Macro 压缩后恢复的 Agent 运行态；正常装配时不重复投递。 */
  readonly postCompactionRestoreContributions?: readonly ContextContribution[];
  readonly toolManifest?: ToolManifestSnapshot;
}

/** 运行时事实由 Context 投递，不进入可由角色或扩展修改的 Prompt Slot。 */
export interface RuntimeEnvironmentSnapshot {
  readonly currentDate: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly workspaceRoot: string | null;
  readonly providerId: string;
  readonly model: string;
}

export interface ContextCacheDiagnostics {
  readonly productPromptRevision: string;
  readonly activeCharacterRevision: string;
  readonly turnPromptRevision: string;
  readonly completePromptRevision: string;
  readonly toolManifestRevision: string | null;
  readonly prefixHash: string | null;
}

/** 一次模型调用看到的完整只读快照，也是缓存诊断使用的版本事实。 */
export interface ModelContextSnapshot {
  readonly promptRevision: string;
  readonly toolManifestRevision: string | null;
  readonly messages: readonly Message[];
  /** 压缩后的可持久循环历史；Agent 下一次迭代复用它，避免重复生成摘要。 */
  readonly history: readonly Message[];
  readonly tools: readonly LlmToolDef[];
  readonly cache: ContextCacheDiagnostics;
}
