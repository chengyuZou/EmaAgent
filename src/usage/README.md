# Usage

模型能力的一次物理调用结束后, 调用方把终态传给 `UsageRecorder.record`. Recorder 在 Usage 包内映射为 `UsageRecordRow`, 并通过 Storage 的 `UsageRecordsRepo` 写入 `usage_records`. 失败和取消同样记录; Provider 未报告的计量字段保持 `null`.

Recorder 不发应用事件. 写库失败只记录警告, 不改变模型调用本身的结果. 明细页通过 HTTP 查询数据库事实.

`record` 接收完整 `UsageRecord`, 调用方负责物理调用 ID, 归属身份和终态. `list` 提供明细分页, `forTurn` 为 History 统计提供该 Turn 的记录. 两者都在 Usage 内把 SQL Row 映射成业务字段, Route 不直接消费 SQL Row.
