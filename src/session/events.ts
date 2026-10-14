// 通知已落库的会话列表或消息变化，供其他窗口重新查询投影。
export type SessionEvent =
  | {
      readonly type: 'session_list_changed';
      /** 会话操作携带对应 ID; 项目操作不携带, 需要重新读取列表. */
      readonly sessionId?: string;
    }
  | {
      readonly type: 'sessions_deleted';
      /** 一批已提交的删除只通知一次, 消费方按这些 ID 移除缓存或更新列表. */
      readonly sessionIds: readonly string[];
    }
  | { readonly type: 'session_messages_changed'; readonly sessionId: string };
