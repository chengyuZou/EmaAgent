// 前端本地斜杠命令：只含不提交后端的纯 UI 动作（新建/分支/重命名等直接调对应 store 入口）。
// 与后端 /api/commands 目录（确定性命令，V1=compact）在菜单的"命令"节合并展示。
export interface LocalCommandDescriptor {
  /** 菜单触发名（不含 '/' 前缀），与过滤词匹配。 */
  readonly name: string;
  readonly description: string;
  readonly icon: string;
}

export const LOCAL_COMMANDS: readonly LocalCommandDescriptor[] = [
  { name: 'new', description: '新建聊天', icon: 'i-lucide:plus' },
  { name: 'fork', description: '创建当前聊天的分支', icon: 'i-lucide:git-fork' },
  { name: 'rename', description: '重命名当前聊天', icon: 'i-lucide:pencil' },
  { name: 'pin', description: '置顶或取消置顶当前聊天', icon: 'i-lucide:pin' },
  { name: 'archive', description: '归档当前聊天', icon: 'i-lucide:archive' },
];
