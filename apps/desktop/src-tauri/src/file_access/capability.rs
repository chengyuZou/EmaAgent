// 使用 OS keychain 主密钥签发和验证 AES-256-GCM 本地文件能力句柄。
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::types::AuthorizedFile;

const HANDLE_PREFIX: &str = "ema-file:v1";
const HANDLE_DOMAIN: &[u8] = b"ema-file-capability:v1";
const NONCE_BYTES: usize = 12;

#[derive(Clone)]
pub struct FileAccessFacade {
    key: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct FilePayload {
    path: String,
}

impl FileAccessFacade {
    pub fn new(master_key_hex: &str) -> Result<Self, String> {
        let master_key = decode_hex_key(master_key_hex)?;
        let hkdf = Hkdf::<Sha256>::new(None, &master_key);
        let mut key = [0_u8; 32];
        hkdf.expand(HANDLE_DOMAIN, &mut key)
            .map_err(|_| "派生文件能力密钥失败".to_string())?;
        Ok(Self { key })
    }

    pub fn authorize_paths<I>(&self, paths: I) -> Vec<AuthorizedFile>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        paths
            .into_iter()
            .filter_map(|path| match self.authorize_path(&path) {
                Ok(file) => Some(file),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "skip unauthorized attachment path");
                    None
                }
            })
            .collect()
    }

    pub fn resolve(&self, file_handle: &str) -> Result<PathBuf, String> {
        let mut parts = file_handle.split(':');
        if parts.next() != Some("ema-file") || parts.next() != Some("v1") {
            return Err("文件能力句柄格式错误".to_string());
        }
        let nonce = decode_canonical(parts.next().ok_or("文件能力句柄缺少 nonce")?)?;
        let sealed = decode_canonical(parts.next().ok_or("文件能力句柄缺少密文")?)?;
        if parts.next().is_some() || nonce.len() != NONCE_BYTES || sealed.len() <= 16 {
            return Err("文件能力句柄参数长度错误".to_string());
        }

        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| "初始化文件能力解密器失败".to_string())?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &sealed,
                    aad: HANDLE_DOMAIN,
                },
            )
            .map_err(|_| "文件能力句柄无法通过完整性校验".to_string())?;
        let payload: FilePayload =
            serde_json::from_slice(&plaintext).map_err(|_| "文件能力负载格式错误".to_string())?;
        let path = PathBuf::from(payload.path);
        if !path.is_absolute() {
            return Err("文件能力只接受绝对路径".to_string());
        }
        Ok(path)
    }

    fn authorize_path(&self, path: &Path) -> Result<AuthorizedFile, String> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|error| format!("解析附件真实路径失败: {error}"))?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("读取附件元数据失败: {error}"))?;
        if !metadata.is_file() {
            return Err("附件必须是普通文件".to_string());
        }
        let name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "附件名称不是有效 UTF-8".to_string())?
            .to_string();
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        Ok(AuthorizedFile {
            file_handle: self.issue(&canonical)?,
            name,
            size: metadata.len(),
            mtime,
        })
    }

    fn issue(&self, path: &Path) -> Result<String, String> {
        let mut nonce = [0_u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);
        self.issue_with_nonce(path, nonce)
    }

    fn issue_with_nonce(&self, path: &Path, nonce: [u8; NONCE_BYTES]) -> Result<String, String> {
        let path = path
            .to_str()
            .ok_or_else(|| "附件路径不是有效 UTF-8".to_string())?;
        let plaintext = serde_json::to_vec(&FilePayload {
            path: path.to_string(),
        })
        .map_err(|error| format!("序列化文件能力失败: {error}"))?;
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| "初始化文件能力加密器失败".to_string())?;
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: HANDLE_DOMAIN,
                },
            )
            .map_err(|_| "签发文件能力句柄失败".to_string())?;
        Ok(format!(
            "{HANDLE_PREFIX}:{}:{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(sealed),
        ))
    }
}

fn decode_canonical(value: &str) -> Result<Vec<u8>, String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "文件能力句柄包含非法编码".to_string())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err("文件能力句柄包含非规范编码".to_string());
    }
    Ok(decoded)
}

fn decode_hex_key(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("文件能力主密钥必须是 32 字节十六进制".to_string());
    }
    let mut key = [0_u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "文件能力主密钥格式错误".to_string())?;
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[test]
    fn rejects_tampered_handle() {
        let facade = FileAccessFacade::new(MASTER_KEY).unwrap();
        let mut handle = facade.issue(Path::new("C:\\Users\\Ema\\test.txt")).unwrap();
        let replacement = if handle.ends_with('A') { 'B' } else { 'A' };
        handle.pop();
        handle.push(replacement);
        assert!(facade.resolve(&handle).is_err());
    }

    #[test]
    fn matches_node_file_capability_protocol() {
        let facade = FileAccessFacade::new(MASTER_KEY).unwrap();
        let nonce = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        #[cfg(windows)]
        let (path, expected) = (
            Path::new("C:\\Users\\Ema\\test.txt"),
            "ema-file:v1:AAECAwQFBgcICQoL:tARCk_QBynE6TmCEF8f4kOv6TpOeaOOtd6TKRZNX5wa8kvRPGnpNWPKHP0LDlo68Ez50",
        );
        #[cfg(unix)]
        let (path, expected) = (
            Path::new("/tmp/ema-test.txt"),
            "ema-file:v1:AAECAwQFBgcICQoL:tARCk_QBynE6Ii61O73umPikZqqocayFU6SNS_X9qA42o--Uq3dVo1Lvzlk",
        );

        assert_eq!(facade.issue_with_nonce(path, nonce).unwrap(), expected);
        assert_eq!(facade.resolve(expected).unwrap(), path);
    }
}
