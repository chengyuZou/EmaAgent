-- 024: 删除从未接入生产写入链的 telemetry_events 半成品。
--
-- 模型 Usage 已由 usage_records 明确持久化；未来若增加本地诊断事件，
-- 需要重新定义生产者、隐私边界、查询入口和保留策略，不能复用万能 JSON 表。

DROP TABLE IF EXISTS telemetry_events;
