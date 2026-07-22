-- Provider 能力表已承接地址、协议和能力开关，物理删除旧配置占位列。
ALTER TABLE provider_configs DROP COLUMN base_url;
ALTER TABLE provider_configs DROP COLUMN config_json;
ALTER TABLE provider_configs DROP COLUMN capabilities_json;
