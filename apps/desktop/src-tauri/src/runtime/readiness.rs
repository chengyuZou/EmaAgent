// 读取并校验 LocalHost/Bridge 原子写入的结构化启动握手。
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;

use super::types::RuntimeService;

pub const RUNTIME_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyRecord {
    pub service: String,
    pub pid: u32,
    pub port: u16,
    pub nonce: String,
    pub protocol_version: u32,
}

pub async fn wait_for_ready(
    path: &Path,
    service: RuntimeService,
    expected_pid: Option<u32>,
    expected_nonce: &str,
    max_wait: Duration,
    shutdown_requested: &AtomicBool,
) -> Result<ReadyRecord, String> {
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        if shutdown_requested.load(Ordering::Acquire) {
            return Err(format!("{} startup cancelled", service.as_str()));
        }

        match tokio::fs::read(path).await {
            Ok(bytes) => {
                let record: ReadyRecord = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("invalid {} readiness: {error}", service.as_str()))?;
                validate_ready(&record, service, expected_pid, expected_nonce)?;
                return Ok(record);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("read {} readiness: {error}", service.as_str()));
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(format!("{} readiness timed out", service.as_str()));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn validate_ready(
    record: &ReadyRecord,
    service: RuntimeService,
    expected_pid: Option<u32>,
    expected_nonce: &str,
) -> Result<(), String> {
    if record.service != service.as_str() {
        return Err(format!(
            "readiness service mismatch: expected {}, got {}",
            service.as_str(),
            record.service,
        ));
    }
    // 仅当启动器即服务本体(打包直启 exe)时才要求 PID 相等;
    // 开发期经 pnpm/uv 包装器启动,readiness 里的 PID 是真实服务进程的。
    // 本次启动的新鲜性由每轮唯一 runtime 目录 + 随机 nonce 保证,与 PID 无关。
    if let Some(expected_pid) = expected_pid {
        if record.pid != expected_pid {
            return Err(format!(
                "{} readiness pid mismatch: expected {expected_pid}, got {}",
                service.as_str(),
                record.pid,
            ));
        }
    }
    if record.nonce != expected_nonce {
        return Err(format!("{} readiness nonce mismatch", service.as_str()));
    }
    if record.protocol_version != RUNTIME_PROTOCOL_VERSION {
        return Err(format!(
            "{} protocol mismatch: host={}, child={}",
            service.as_str(),
            RUNTIME_PROTOCOL_VERSION,
            record.protocol_version,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> ReadyRecord {
        ReadyRecord {
            service: "local-host".to_string(),
            pid: 42,
            port: 3421,
            nonce: "run-a".to_string(),
            protocol_version: RUNTIME_PROTOCOL_VERSION,
        }
    }

    #[test]
    fn rejects_stale_nonce() {
        let error =
            validate_ready(&ready(), RuntimeService::LocalHost, Some(42), "run-b").unwrap_err();
        assert!(error.contains("nonce mismatch"));
    }

    #[test]
    fn rejects_foreign_pid_when_launcher_is_service() {
        let error =
            validate_ready(&ready(), RuntimeService::LocalHost, Some(99), "run-a").unwrap_err();
        assert!(error.contains("pid mismatch"));
    }

    #[test]
    fn accepts_service_pid_when_launcher_is_wrapper() {
        // 开发期包装器(pnpm/uv)的 PID 与真实服务 PID 天然不同,不参与等值校验。
        validate_ready(&ready(), RuntimeService::LocalHost, None, "run-a").unwrap();
    }
}
