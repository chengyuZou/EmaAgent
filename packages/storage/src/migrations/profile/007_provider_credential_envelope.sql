-- B-020：Provider 凭据从明文升级为由 CredentialFacade 管理的 AES-GCM 信封。
-- 迁移只改列名；Core 启动时会在单事务中把旧明文原地加密。
ALTER TABLE provider_configs RENAME COLUMN api_key_plain TO credential_envelope;
