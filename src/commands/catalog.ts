export interface CommandDescriptor {
  /** 菜单触发名, 不含 '/' 前缀. */
  readonly name: string;
  readonly description: string;
}

/** 确定性操作目录, Goal 的管理界面由聊天端打开, 不建命令注册表. */
export function listCommandDescriptors(): readonly CommandDescriptor[] {
  return [
    {
      name: 'compact',
      description: '压缩当前会话历史: 生成摘要替换模型请求中的旧消息, 释放上下文空间',
    },
    {
      name: 'goal',
      description: '设立或编辑当前会话持续推进的目标',
    },
  ];
}
