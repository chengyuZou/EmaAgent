-- Message 没有开放扩展元数据；删除从未被业务读取的万能 JSON 列。
ALTER TABLE messages DROP COLUMN meta_json;
