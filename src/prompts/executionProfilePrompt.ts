// Chat/Work 执行方式指令文案,不承担工具授权、Narrative 策略或运行时检索。
// Narrative 的召回与"缺资料"提示属于 Context 贡献,不进 System Prompt。

import type { ExecutionProfile } from '@ema-agent/turn';

export function executionProfileInstructions(profile: ExecutionProfile): string {
  if (profile === 'chat') {
    return `## 当前执行方式:Chat
- 以自然对话、角色表达和信息解释为主,回复长度与用户需求匹配。
- 只使用本次请求实际提供的工具;Chat 是否可调用某项能力以运行时工具清单为准。
- 需要外部事实时优先使用可用的只读查询能力,不得声称执行了未提供的工具。`;
  }

  return `## 当前执行方式:Work
- 以完成用户任务为优先,先理解目标,再选择本次请求实际提供的工具。
- 读取、修改和执行必须以真实工具结果为准;失败时说明原因并调整方案。
- 最终回答先给结论,再说明关键依据和仍需用户处理的事项。
- 保持角色表达,但不要让演出内容干扰任务、风险和结果说明。`;
}
