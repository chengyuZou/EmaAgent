use keyring::{Entry, Error as KeyringError};
use rand::{rngs::OsRng, RngCore};

const SERVICE: &str = "dev.ema-agent.credentials";
const ACCOUNT: &str = "provider-master-key-v1";
const ENV_NAME: &str = "EMA_CREDENTIAL_MASTER_KEY";

fn is_valid_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn generate_key() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/** 每次进程启动生成新的 256-bit Sidecar/Bridge 认证令牌。 */
pub fn generate_ephemeral_secret() -> String {
    generate_key()
}

///
/// 读取由操作系统凭据库保护的 256-bit 主密钥。
///
/// CI/无桌面 Secret Service 环境可以显式注入同名环境变量；正常桌面启动会
/// 使用 Windows Credential Manager、macOS Keychain 或 Linux Secret Service。
/// 凭据库不可用时 fail-closed，绝不把主密钥回退写入普通文件。
pub fn load_or_create_master_key() -> Result<String, String> {
    if let Ok(value) = std::env::var(ENV_NAME) {
        if is_valid_key(&value) {
            return Ok(value);
        }
        return Err(format!("{ENV_NAME} 格式错误，必须是 32 字节十六进制"));
    }

    let entry =
        Entry::new(SERVICE, ACCOUNT).map_err(|error| format!("打开 OS keychain 失败: {error}"))?;

    match entry.get_password() {
        Ok(value) if is_valid_key(&value) => Ok(value),
        Ok(_) => Err("OS keychain 中的 EmaAgent 主密钥格式损坏".to_string()),
        Err(KeyringError::NoEntry) => {
            let value = generate_key();
            entry
                .set_password(&value)
                .map_err(|error| format!("写入 OS keychain 失败: {error}"))?;
            Ok(value)
        }
        Err(error) => Err(format!("读取 OS keychain 失败: {error}")),
    }
}
