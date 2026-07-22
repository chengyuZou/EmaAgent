// 把 Chat/Work 与 Narrative 策略转换为行为指令，不承担工具授权或运行时检索。

import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';
import type { PromptSlotContribution } from './types.js';

export function buildExecutionProfileContribution(
  executionProfile: ExecutionProfile,
  narrativePolicy: NarrativePolicy,
): PromptSlotContribution {
  return {
    id: 'profile.execution',
    content: [
      executionProfileInstructions(executionProfile),
      narrativePolicyInstructions(narrativePolicy),
    ].join('\n\n'),
    version: `execution-profile:v1:${executionProfile}:narrative:${narrativePolicy}`,
  };
}

function executionProfileInstructions(profile: ExecutionProfile): string {
  if (profile === 'chat') {
    return `## 当前执行方式：Chat
- 以自然对话、角色表达和信息解释为主，回复长度与用户需求匹配。
- 只使用本次请求实际提供的工具；Chat 是否可调用某项能力以运行时工具清单为准。
- 需要外部事实时优先使用可用的只读查询能力，不得声称执行了未提供的工具。`;
  }

  return `## 当前执行方式：Work
- 以完成用户任务为优先，先理解目标，再选择本次请求实际提供的工具。
- 读取、修改和执行必须以真实工具结果为准；失败时说明原因并调整方案。
- 最终回答先给结论，再说明关键依据和仍需用户处理的事项。
- 保持角色表达，但不要让演出内容干扰任务、风险和结果说明。`;
}

function narrativePolicyInstructions(policy: NarrativePolicy): string {
  switch (policy) {
    case 'auto':
      return `## 剧情资料策略：自动
- 回答依赖剧情、人物经历或世界观细节时，按需使用本次请求提供的 Narrative 检索能力。
- 没有可靠剧情资料时明确不确定，不自行补造关键设定。`;
    case 'always':
      return `## 剧情资料策略：始终检索
- 运行时会在正式回答前提供 Narrative 召回结果，应优先依据这些资料回答。
- 召回部分失败或证据不足时明确说明，不用推测填补关键剧情。`;
    case 'off':
      return `## 剧情资料策略：关闭
- 不请求 Narrative 剧情检索；角色基础设定仍然有效。
- 涉及具体剧情细节而现有上下文不足时，提醒用户当前可能缺少资料。`;
  }
}
