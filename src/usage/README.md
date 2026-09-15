# Usage

模型能力调用通过 `UsageRecorder.record` 写入 `usage_records`。Server 装配的记录器在 SQL 写入成功后发 `usage_recorded { sessionId }`；`sessionId=null` 表示不属于某个会话的调用，只刷新全局统计。写入失败不发送事件，也不改变模型调用的业务终态。
