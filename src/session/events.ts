// 通知已落库的会话列表或消息变化，供其他窗口重新查询投影。
export type SessionEvent =
  | { readonly type: 'session_list_changed' }
  | { readonly type: 'session_messages_changed'; readonly sessionId: string };
