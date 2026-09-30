// Command 目录投影：只投影确定性命令自身的展示信息。Skill 目录归 skills 包
// 公共入口（/api/skills），前端菜单把两份目录合并展示，这里不复制 Skill 任何字段。
export interface CommandDescriptor {
  /** 菜单触发名（不含 '/' 前缀）。 */
  readonly name: string;
  readonly description: string;
}

/** 确定性操作目录, Goal 的管理界面由聊天端打开, 不建命令注册表. */
export function listCommandDescriptors(): readonly CommandDescriptor[] {
  return [
    {
      name: 'compact',
      description: '压缩当前会话历史：生成摘要替换旧消息，立即释放上下文空间',
    },
    {
      name: 'goal',
      description: '设立或编辑当前会话持续推进的目标',
    },
  ];
}
