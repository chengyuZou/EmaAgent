import { assembleToolPool, BuiltinTools, readToolSettings } from '@ema-agent/tools';
import { staticSystemPrompt, getDynamicSystemPrompt, type DynamicSystemPromptInput } from '@ema-agent/prompts';
import { renderSkillListing } from '@ema-agent/skills';
import type { PermissionMode } from '@ema-agent/permission';
import { TurnPreparationError } from '../errors.js';
import type { PrepareTurnDeps } from './prepareTurn.js';
import { resolveSkillPool } from './skillPool.js';

// Plan 只暴露整项能力均只读的工具. isReadOnly(input) 依赖尚未生成的参数,
// 不能用于装配筛选; Shell, 子代理和用户交互不作为只读例外放行.
const PLAN_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.FileRead.id,
  BuiltinTools.DescribeImage.id,
  BuiltinTools.Capture.id,
  BuiltinTools.Glob.id,
  BuiltinTools.Grep.id,
  BuiltinTools.WebFetch.id,
  BuiltinTools.WebSearch.id,
  BuiltinTools.ProcessList.id,
  BuiltinTools.ProcessOutput.id,
  BuiltinTools.TaskGet.id,
  BuiltinTools.TaskList.id,
  BuiltinTools.NarrativeSearch.id,
  BuiltinTools.MemorySearch.id,
  BuiltinTools.MemoryRead.id,
  BuiltinTools.MemoryList.id,
  BuiltinTools.Skill.id,
  BuiltinTools.ScratchpadRead.id,
  BuiltinTools.ScratchpadList.id,
]);

export type ContextInputDeps = Pick<PrepareTurnDeps,
  | 'sessions' | 'providerModels' | 'settings' | 'registry'
  | 'characterPrompt' | 'skillEntries' | 'disabledSkillPaths'
  | 'workspaceInstructions' | 'memoryGuidance'
>;

/** 实际 Turn 和空闲估算共用; 不创建执行器, 不保存附件, 不调用模型. */
export async function prepareContextInput(
  deps: ContextInputDeps,
  sessionId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const session = deps.sessions.getSession(sessionId);
  const permissionMode = session.permissionMode;
  const cwd = session.cwd;
  const projectId = session.projectId;
  const projectFolders = projectId
    ? deps.sessions.listProjectFolders(projectId).map((folder) => folder.path)
    : [];
  const workspaceRoots = projectFolders.length > 0 ? projectFolders : [cwd];

  const providerId = session.providerId;
  const modelId = session.modelId;
  if (!providerId || !modelId) {
    throw new TurnPreparationError(
      'provider/not_configured',
      '当前 Session 未指定 providerId/modelId',
    );
  }
  const modelFacts = deps.providerModels.get(providerId, 'llm', modelId);
  if (!modelFacts || modelFacts.capability !== 'llm') {
    throw new TurnPreparationError(
      'provider/not_configured',
      `模型未在该 Provider 下启用：${providerId} / ${modelId}`,
    );
  }

  const skillPool = await resolveSkillPool(
    { settings: deps.settings, skillEntries: deps.skillEntries, disabledSkillPaths: deps.disabledSkillPaths },
    cwd,
    projectId,
  );

  signal.throwIfAborted();
  const toolPool = selectTurnToolPool(deps, permissionMode);
  const dynamicInput: DynamicSystemPromptInput = Object.freeze({
    characterPrompt: deps.characterPrompt,
    permissionMode,
    toolNames: toolPool.tools.map(tool => tool.name),
    environment: {
      platform: process.platform,
      cwd: cwd || null,
      projectFolderPaths: projectFolders,
      providerId,
      modelId,
    },
    workspaceInstructions: cwd ? deps.workspaceInstructions?.(cwd) ?? null : null,
    memorySection: await deps.memoryGuidance?.() ?? null,
    skillCatalog: skillPool ? renderSkillListing(skillPool) : null,
    // MCP 指引尚无生产者, 不自行补正文.
    mcpInstructions: null,
  });
  const systemPrompt = Object.freeze([
    ...staticSystemPrompt,
    ...getDynamicSystemPrompt(dynamicInput),
  ]);

  signal.throwIfAborted();
  return {
    session, providerId, modelId, modelFacts, cwd, projectId, workspaceRoots,
    skillPool, toolPool, dynamicInput, systemPrompt,
  };
}

export function selectTurnToolPool(
  deps: Pick<ContextInputDeps, 'settings' | 'registry'>,
  permissionMode: PermissionMode,
) {
  const disabledToolIds = new Set(readToolSettings(deps.settings).disabledToolIds);
  const enabledPool = assembleToolPool(deps.registry)
    .filter(tool => !disabledToolIds.has(tool.id));
  return permissionMode === 'plan'
    ? enabledPool.filter(tool => PLAN_TOOL_IDS.has(tool.id))
    : enabledPool;
}
