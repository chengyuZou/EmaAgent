/**
 * 带内置资源保护的删除结果。
 *
 * Storage 只报告持久化结果，不在这里决定 HTTP 状态码或用户文案；
 * 上层 Facade 可以稳定映射为成功、不存在和禁止删除三种业务结果。
 */
export type ProtectedDeleteResult =
  | 'deleted'
  | 'not_found'
  | 'builtin_protected';
