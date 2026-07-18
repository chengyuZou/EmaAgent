# @ema-agent/credential

Provider 凭据(API key)加解密层。把存进 SQLite `provider_configs.credential` 字段的 API key 从明文改成密文,取代旧 `api_key_plain`。

## 机制

- **算法**: AES-256-GCM(对称加密 + 完整性校验)
- **密钥来源**: 主密钥从环境变量 `EMA_CREDENTIAL_MASTER_KEY` 读(32 字节 = 64 hex 字符),由 Tauri 从 OS keychain 注入;包本身不存主密钥
- **AAD 绑定**: provider ID 作 AAD。即使数据库两行密文被交换/复制,GCM 完整性校验直接拒,防"把 A provider 密文挪到 B provider 行套用"
- **密文格式**: `ema-credential:v1:<nonce>:<tag>:<ciphertext>`,三段 base64url;每条独立随机 nonce
- **兼容旧数据**: `reveal()` 遇不带前缀的老明文直接返回,由 `ProvidersRepo` 启动时原地加密迁移

## Facade

| Facade | 职责 |
|---|---|
| `CredentialFacade` | 唯一跨模块入口: `isProtected` / `protect(subjectId, plaintext)` / `reveal(subjectId, storedValue)` |
| `requireCredentialMasterKey(env)` | 从环境变量读主密钥,缺失/格式错抛 `CredentialConfigurationError`(fail-closed,拒绝无密钥运行) |

## 错误

- `CredentialConfigurationError`: 主密钥缺失/格式错
- `CredentialIntegrityError`: 密文损坏/完整性校验失败/被篡改

## 不做

- 不存主密钥(只从环境变量读)
- 不管理 OS keychain(由 Tauri 壳负责注入环境变量)
- 不做 key rotation(无版本切换;换主密钥需重新加密全部密文)
