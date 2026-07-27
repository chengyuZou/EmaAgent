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
    expected_pid: u32,
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
    expected_pid: u32,
    expected_nonce: &str,
) -> Result<(), String> {
    if record.service != service.as_str() {
        return Err(format!(
            "readiness service mismatch: expected {}, got {}",
            service.as_str(),
            record.service,
        ));
    }
    if record.pid != expected_pid {
        return Err(format!(
            "{} readiness pid mismatch: expected {expected_pid}, got {}",
            service.as_str(),
            record.pid,
        ));
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
        let error = validate_ready(&ready(), RuntimeService::LocalHost, 42, "run-b").unwrap_err();
        assert!(error.contains("nonce mismatch"));
    }

    #[test]
    fn rejects_foreign_pid() {
        let error = validate_ready(&ready(), RuntimeService::LocalHost, 99, "run-a").unwrap_err();
        assert!(error.contains("pid mismatch"));
    }
}
