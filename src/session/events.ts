export type SessionEvent =
  | {
      readonly type: 'session_list_changed';
      /** 会话操作携带对应 ID; 项目操作不携带, 需要重新读取列表. */
      readonly sessionId?: string;
    }
  | {
      readonly type: 'sessions_deleted';
      /** SQL 已提交删除的 ID. 删除全部归档可能包含多个 Session, 因此使用数组; 单个删除只有一个 ID. */
      readonly sessionIds: readonly string[];
    }
  | { readonly type: 'session_messages_changed'; readonly sessionId: string };
