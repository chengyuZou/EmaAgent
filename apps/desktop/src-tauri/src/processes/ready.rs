// 等待 Server/Narrative Bridge 原子写入实际监听端口。
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ReadyRecord {
    port: u16,
}

pub async fn wait_for_ready(
    path: &Path,
    label: &str,
    max_wait: Duration,
    shutdown_requested: &AtomicBool,
) -> Result<u16, String> {
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        if shutdown_requested.load(Ordering::Acquire) {
            return Err(format!("{label} startup cancelled"));
        }

        match tokio::fs::read(path).await {
            Ok(bytes) => {
                let record: ReadyRecord = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("invalid {label} readiness: {error}"))?;
                if record.port == 0 {
                    return Err(format!(
                        "invalid {label} readiness: port must be greater than zero"
                    ));
                }
                return Ok(record.port);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("read {label} readiness: {error}"));
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(format!("{label} readiness timed out"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
