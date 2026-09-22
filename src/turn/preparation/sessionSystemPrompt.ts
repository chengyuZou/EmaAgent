// 按 Session 与模型组装 System Prompt 的两个共享步骤：根 Turn（prepareTurn）与
// /compact Command 共用，事实不变时逐字节一致（KV 前缀共享的前提）。
// 拆开两个函数是因为 Turn 在工具层装配前就需要 Pool，而 toolNames 在工具层之后才有。
import { getSystemPrompt, type PromptBlock } from '@ema-agent/prompts';
import type { SessionMode } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  disabledProjectSourcesSetting,
  freezeSkillPool,
  renderSkillListing,
  type SkillDescriptor,
  type SkillPool,
} from '@ema-agent/skills';

export interface SkillPoolDeps {
  readonly settings: SettingsStore;
  /** SkillRegistry 当前全量条目（含工作区的 project 技能）。 */
  readonly skillEntries: (
    cwd: string,
    projectId: string | null,
  ) => Promise<readonly SkillDescriptor[]>;
  /** skill_enablement 表的当前禁用路径列表（builtin/user 逐技能启停）。 */
  readonly disabledSkillPaths: () => readonly string[];
}

/** Chat 与 Work 使用同一份冻结的 Skill 目录。 */
export async function resolveSkillPool(
  deps: SkillPoolDeps,
  cwd: string,
  projectId: string | null,
): Promise<SkillPool | undefined> {
  const skillEntries = await deps.skillEntries(cwd, projectId);
  if (skillEntries.length === 0) return undefined;
  return freezeSkillPool({
    entries: skillEntries,
    disabledPaths: deps.disabledSkillPaths(),
    disabledProjectSources: deps.settings.get(disabledProjectSourcesSetting).disabledSourceIds,
  });
}

export interface SessionSystemPromptDeps {
  /** 角色包公共口：取当下全局唯一激活角色的 Prompt 段落（扁平数组）。 */
  readonly characterPrompt: () => readonly string[];
  /** 工作区指令（EMA.md/CLAUDE.md）按工作区读取；无工作区时不会调用。 */
  readonly workspaceInstructions?: (cwd: string) => string | null;
  /** 记忆使用指引（memory 包 buildMemoryGuidance 产出）。 */
  readonly memoryGuidance?: () => Promise<string | null> | string | null;
}

export interface SessionSystemPromptInput {
  readonly sessionMode: SessionMode;
  readonly cwd: string;
  readonly projectFolderPaths: readonly string[];
  readonly providerId: string;
  readonly modelId: string;
  /** 当次 ToolPool 的工具名集合（能力引导只按名字判定存在性）；Command 不装配 ToolPool，传空。 */
  readonly toolNames: readonly string[];
  readonly skillPool?: SkillPool;
}

/** 装配 Session 级 System Prompt（PromptBlock 扁平数组）；MCP 指引尚无生产者，恒 null。 */
export async function buildSessionSystemPrompt(
  deps: SessionSystemPromptDeps,
  input: SessionSystemPromptInput,
): Promise<readonly PromptBlock[]> {
  const { sessionMode, cwd } = input;
  return getSystemPrompt({
    characterPrompt: deps.characterPrompt,
    sessionMode,
    toolNames: input.toolNames,
    environment: {
      platform: process.platform,
      cwd: cwd || null,
      projectFolderPaths: input.projectFolderPaths,
      providerId: input.providerId,
      modelId: input.modelId,
    },
    workspaceInstructions: cwd
      ? (deps.workspaceInstructions?.(cwd) ?? null)
      : null,
    memorySection: await deps.memoryGuidance?.() ?? null,
    skillCatalog: input.skillPool ? renderSkillListing(input.skillPool) : null,
    // MCP server instructions 尚无生产者（MCP 包未存 InitializeResult instructions），到位后恢复。
    mcpInstructions: null,
  });
}
